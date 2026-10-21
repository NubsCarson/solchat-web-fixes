import { test, expect, mock } from "bun:test";
import { JSDOM } from "jsdom";
import React, { act } from "react";

let signatures, cached, reads, invalidations, accountUpdates, nextRead;
mock.module("@/lib/rpc/cache", () => ({
  updateAccountCache: (key, info) => accountUpdates.push({ key, info }),
  invalidateSignatureCache: (key) => {
    invalidations.push(key);
    cached = undefined;
  },
  getCachedSignatures: async () => {
    reads++;
    if (nextRead) {
      const pending = nextRead;
      nextRead = null;
      return pending;
    }
    cached ??= signatures.map((signature) => ({ signature }));
    return cached;
  },
}));
const { useAccountSubscription } = await import(
  "../lib/shared/use-account-subscription"
);
const { createRoot } = await import("react-dom/client");

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(initialRead) {
  signatures = ["old"];
  cached = undefined;
  reads = 0;
  invalidations = [];
  accountUpdates = [];
  nextRead = initialRead;
  const dom = new JSDOM('<div id="root"></div>', { url: "http://localhost" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalNow = Date.now;
  let now = 10_000,
    id = 0,
    listener;
  const timers = new Map();
  globalThis.setTimeout = (fn, delay = 0) => {
    timers.set(++id, { fn, at: now + delay });
    return id;
  };
  globalThis.clearTimeout = (timer) => timers.delete(timer);
  Date.now = () => now;
  const removed = [],
    delivered = [];
  const account = { toBase58: () => "local-subscription-account" };
  const connection = {
    onAccountChange: (_account, callback) => {
      listener = callback;
      return 7;
    },
    removeAccountChangeListener: async (subscription) =>
      removed.push(subscription),
  };
  function Probe() {
    useAccountSubscription({
      connection,
      account,
      onNewSignatures: async (batch) => delivered.push(batch),
    });
    return null;
  }
  const root = createRoot(document.getElementById("root"));
  let mounted = true;
  await act(async () => root.render(<Probe />));
  return {
    delivered,
    removed,
    emit: async () => act(async () => listener({ data: new Uint8Array([1]) })),
    advance: async (milliseconds) => {
      const until = now + milliseconds;
      // Run due callbacks in time order. Do not await an intentionally pending
      // RPC promise: tests must also be able to unmount while it is in flight.
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        await act(async () => {
          void due[1].fn();
        });
      }
      now = until;
    },
    unmount: async () => {
      if (!mounted) return;
      mounted = false;
      await act(async () => root.unmount());
    },
    close: async () => {
      if (mounted) await act(async () => root.unmount());
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      Date.now = originalNow;
      dom.window.close();
    },
  };
}

test("account updates invalidate the cached signature snapshot before decoding new signatures", async () => {
  const view = await setup();
  try {
    expect(reads).toBe(1);
    signatures = ["newest", "newer", "old"];
    await view.emit();
    expect(invalidations).toContain("local-subscription-account");
    expect(accountUpdates).toHaveLength(1);
    await view.advance(150);
    expect(view.delivered).toEqual([["newer", "newest"]]);
    expect(reads).toBe(2);
  } finally {
    await view.close();
  }
});

test("a lone account update inside the one-second debounce is eventually delivered", async () => {
  const view = await setup();
  try {
    signatures = ["first", "old"];
    await view.emit();
    await view.advance(150);
    expect(view.delivered).toEqual([["first"]]);
    await view.advance(100);
    signatures = ["second", "first", "old"];
    await view.emit();
    await view.advance(899);
    expect(view.delivered).toEqual([["first"]]);
    await view.advance(1);
    expect(view.delivered).toEqual([["first"], ["second"]]);
    expect(reads).toBe(3);
  } finally {
    await view.close();
  }
});

test("an update arriving during the initial snapshot is not swallowed into the baseline", async () => {
  const initial = deferred();
  const view = await setup(initial.promise);
  try {
    signatures = ["during-baseline", "old"];
    await view.emit();
    await act(async () =>
      initial.resolve(signatures.map((signature) => ({ signature }))),
    );
    await view.advance(150);
    expect(view.delivered.flat()).toContain("during-baseline");
    expect(view.delivered).toHaveLength(1);
    expect(reads).toBe(2);
  } finally {
    await view.close();
  }
});

test("unmount cancels a scheduled account-update callback and removes its listener", async () => {
  const view = await setup();
  try {
    signatures = ["after-unmount", "old"];
    await view.emit();
    await view.unmount();
    await view.advance(2000);
    expect(view.delivered).toEqual([]);
    expect(reads).toBe(1);
    expect(view.removed).toEqual([7]);
    // A late event from an already-dispatched subscription also stays inert.
    await view.emit();
    await view.advance(2000);
    expect(view.delivered).toEqual([]);
    expect(reads).toBe(1);
  } finally {
    await view.close();
  }
});

test("unmount ignores an RPC result that was already in flight", async () => {
  const view = await setup();
  const pending = deferred();
  try {
    nextRead = pending.promise;
    await view.emit();
    await view.advance(150);
    expect(reads).toBe(2);
    await view.unmount();
    await act(async () => pending.resolve([{ signature: "late-result" }]));
    expect(view.delivered).toEqual([]);
    expect(view.removed).toEqual([7]);
  } finally {
    await view.close();
  }
});
