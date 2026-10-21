import { test, expect, mock } from 'bun:test';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';

const sent = [], managers = [], incoming = new Map();
let onSignatures;
let sendBehavior;
let pendingInitialization;
mock.module('@/lib/rpc/cache', () => ({
  getCachedSignatures: async () => [], invalidateSignatureCache() {},
}));
mock.module('@/lib/shared/use-account-subscription', () => ({
  useAccountSubscription: ({ onNewSignatures }) => { onSignatures = onNewSignatures; },
}));
mock.module('../lib/voice/call-signaling', () => ({
  callsTable: { toBase58: () => 'test-call-table' },
  ensureCallsTable: async () => {},
  readCallSignal: async (_connection, signature) => incoming.get(signature) ?? null,
  sendSignal: async (_connection, _signer, signal) => {
    sent.push(signal);
    await sendBehavior(signal, sent.length - 1);
    return `test-signature-${sent.length}`;
  },
}));
mock.module('../lib/voice/webrtc-manager', () => ({
  WebRTCManager: class {
    constructor(config) {
      this.config = config; this.cleaned = false; this.cleanupCount = 0;
      this.stream = { getTracks: () => [] };
      managers.push(this);
    }
    async initialize() {
      if (pendingInitialization) await pendingInitialization;
      this.config.onLocalStream(this.stream);
    }
    async createOffer() { return 'test-sdp-offer'; }
    flushIceCandidatesNow() {}
    async startScreenShare() {}
    cleanup() { this.cleaned = true; this.cleanupCount++; }
  },
}));
const { useVoiceCall } = await import('../lib/voice/useVoiceCall');
const { createRoot } = await import('react-dom/client');

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function installClock() {
  const originalSetTimeout = globalThis.setTimeout, originalClearTimeout = globalThis.clearTimeout;
  let now = 0, nextId = 0;
  const timers = new Map();
  globalThis.setTimeout = (fn, delay = 0) => { timers.set(++nextId, { fn, at: now + delay }); return nextId; };
  globalThis.clearTimeout = (id) => timers.delete(id);
  return {
    timers,
    async advance(milliseconds) {
      const until = now + milliseconds;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); now = due[1].at;
        await act(async () => due[1].fn());
      }
      now = until;
    },
    restore() { globalThis.setTimeout = originalSetTimeout; globalThis.clearTimeout = originalClearTimeout; },
  };
}
async function setup() {
  sent.length = managers.length = 0; incoming.clear();
  sendBehavior = async () => {}; pendingInitialization = null;
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const clock = installClock();
  const connection = { rpcEndpoint: 'http://local-test.invalid' };
  const signer = { publicKey: { toBase58: () => 'test-caller' } };
  let call;
  function Probe() { call = useVoiceCall({ connection, signer, userPubkey: 'test-caller' }); return null; }
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(<Probe />));
  return {
    get call() { return call; }, clock,
    async close() { await act(async () => root.unmount()); clock.restore(); dom.window.close(); },
  };
}

test('hangup closes media immediately and publishes its end before an immediate redial offer', async () => {
  const view = await setup(), firstWrite = deferred();
  sendBehavior = (_signal, index) => index === 0 ? firstWrite.promise : Promise.resolve();
  let first, ending, second;
  try {
    await act(async () => { first = view.call.startCall('test-peer'); });
    expect(sent.map((s) => s.type)).toEqual(['call-offer']);
    expect(view.call.status).toBe('publishing');
    expect(view.call.localStream).toBe(managers[0].stream);
    await act(async () => { ending = view.call.endCall(); });
    expect(managers[0].cleaned).toBe(true);
    expect(view.call.localStream).toBeNull();
    expect(view.call.status).toBe('idle');
    expect(sent).toHaveLength(1);
    await act(async () => { second = view.call.startCall('test-peer'); });
    expect(managers).toHaveLength(2);
    expect(managers[1].cleaned).toBe(false);
    expect(view.call.status).toBe('preparing');
    expect(sent).toHaveLength(1);
    await act(async () => { firstWrite.resolve(); await Promise.all([first, ending, second]); });
    expect(sent.map((s) => s.type)).toEqual(['call-offer', 'call-end', 'call-offer']);
    expect(sent[1].callId).toBe(sent[0].callId);
    expect(sent[2].callId).not.toBe(sent[0].callId);
    expect(view.call.status).toBe('offering');
    expect(view.call.localStream).toBe(managers[1].stream);
    expect(managers[1].cleaned).toBe(false);
  } finally { firstWrite.resolve(); await view.close(); }
});

test('an active call tolerates a brief disconnect, then closes after a persistent disconnect', async () => {
  const view = await setup();
  try {
    await act(async () => { await view.call.startCall('test-peer'); });
    const manager = managers[0];
    await act(async () => manager.config.onConnectionStateChange('connected'));
    expect(view.call.status).toBe('active');
    await act(async () => manager.config.onConnectionStateChange('disconnected'));
    await view.clock.advance(9999);
    expect(view.call.status).toBe('active'); expect(manager.cleaned).toBe(false);
    await act(async () => manager.config.onConnectionStateChange('connected'));
    await view.clock.advance(10001);
    expect(view.call.status).toBe('active'); expect(view.call.webrtcState).toBe('connected'); expect(manager.cleaned).toBe(false);
    await act(async () => manager.config.onConnectionStateChange('disconnected'));
    await view.clock.advance(9999); expect(view.call.status).toBe('active');
    await view.clock.advance(1);
    expect(view.call.status).toBe('idle'); expect(view.call.error).toBe('Call disconnected');
    expect(view.call.localStream).toBeNull(); expect(manager.cleaned).toBe(true); expect(view.clock.timers.size).toBe(0);
  } finally { await view.close(); }
});

test('pending media permission never starts the offer timeout and cancellation discards late media', async () => {
  const view = await setup(), permission = deferred();
  pendingInitialization = permission.promise;
  let starting;
  try {
    await act(async () => { starting = view.call.startCall('test-peer'); });
    const manager = managers[0];
    expect(view.call.status).toBe('preparing'); expect(sent).toEqual([]);
    await view.clock.advance(60000);
    expect(view.call.status).toBe('preparing'); expect(view.call.error).toBeNull(); expect(manager.cleaned).toBe(false); expect(sent).toEqual([]);
    await act(async () => { await view.call.endCall(); });
    expect(view.call.status).toBe('idle'); expect(manager.cleaned).toBe(true); expect(sent).toEqual([]);
    let result;
    await act(async () => { permission.resolve(); result = await starting; });
    expect(result).toBe(false); expect(view.call.status).toBe('idle'); expect(view.call.localStream).toBeNull(); expect(manager.cleanupCount).toBe(2); expect(sent).toEqual([]);
  } finally { permission.resolve(); await view.close(); }
});

test('wallet approval may wait beyond 30 seconds without consuming the ringing timeout', async () => {
  const view = await setup(), write = deferred();
  sendBehavior = () => write.promise;
  let starting;
  try {
    await act(async () => { starting = view.call.startCall('test-peer'); });
    expect(view.call.status).toBe('publishing');
    await view.clock.advance(60000);
    expect(view.call.status).toBe('publishing'); expect(view.call.error).toBeNull(); expect(managers[0].cleaned).toBe(false);
    await act(async () => { write.resolve(); await starting; });
    expect(view.call.status).toBe('offering');
    await view.clock.advance(29999); expect(view.call.status).toBe('offering');
    await view.clock.advance(1); expect(view.call.status).toBe('idle'); expect(view.call.error).toBe('Call was not answered');
  } finally { write.resolve(); await view.close(); }
});

test('an accept received before local offer confirmation is retained without downgrading negotiation', async () => {
  const view = await setup(), write = deferred();
  sendBehavior = (_signal, index) => index === 0 ? write.promise : Promise.resolve();
  let starting, accepting;
  try {
    await act(async () => { starting = view.call.startCall('test-peer'); });
    incoming.set('accept', {type: 'call-accept', callId: sent[0].callId, from: 'test-peer', to: 'test-caller', timestamp: Date.now(), encPubKey: 'a'.repeat(64)});
    await act(async () => { accepting = onSignatures(['accept']); });
    expect(view.call.status).toBe('connecting');
    await act(async () => { write.resolve(); await Promise.all([starting, accepting]); });
    expect(view.call.status).toBe('connecting');
    expect(sent.map((s) => s.type)).toEqual(['call-offer', 'sdp-offer']);
  } finally { write.resolve(); await view.close(); }
});

test('rejection of an old offer cannot clean up a newer call', async () => {
  const view = await setup(), write = deferred();
  sendBehavior = (_signal, index) => index === 0 ? write.promise : Promise.resolve();
  let first, ending, second;
  try {
    await act(async () => { first = view.call.startCall('test-peer'); });
    await act(async () => { ending = view.call.endCall(); });
    await act(async () => { second = view.call.startCall('test-peer'); });
    await act(async () => { write.reject(new Error('Old wallet rejected')); await Promise.all([first, ending, second]); });
    expect(view.call.status).toBe('offering'); expect(view.call.error).toBeNull();
    expect(managers[1].cleaned).toBe(false); expect(view.call.localStream).toBe(managers[1].stream);
  } finally { write.resolve(); await view.close(); }
});

test('canceling preparation while an earlier end is pending preserves the redial barrier', async () => {
  const view = await setup(), endingWrite = deferred();
  let ending, skipped, redial;
  try {
    await act(async () => { await view.call.startCall('test-peer'); });
    sendBehavior = (signal) => signal.type === 'call-end' ? endingWrite.promise : Promise.resolve();
    await act(async () => { ending = view.call.endCall(); });
    await act(async () => { skipped = view.call.startCall('test-peer'); });
    expect(view.call.status).toBe('preparing');
    await act(async () => { await view.call.endCall(); });
    await act(async () => { redial = view.call.startCall('test-peer'); });
    expect(sent.map((s) => s.type)).toEqual(['call-offer', 'call-end']);
    await act(async () => { endingWrite.resolve(); await Promise.all([ending, skipped, redial]); });
    expect(sent.map((s) => s.type)).toEqual(['call-offer', 'call-end', 'call-offer']);
    expect(view.call.status).toBe('offering'); expect(managers[1].cleaned).toBe(true); expect(managers[2].cleaned).toBe(false);
  } finally { endingWrite.resolve(); await view.close(); }
});

test('rejection of a previous accept write leaves a new call and its screen state intact', async () => {
  const view = await setup(), write = deferred();
  let accepting, ending, redial;
  try {
    incoming.set('offer', {type: 'call-offer', callId: 'incoming-old', from: 'test-peer', to: 'test-caller', timestamp: Date.now(), encPubKey: 'a'.repeat(64)});
    await act(async () => { await onSignatures(['offer']); });
    sendBehavior = (signal) => signal.type === 'call-accept' ? write.promise : Promise.resolve();
    await act(async () => { accepting = view.call.acceptCall(); });
    const oldManager = managers[0];
    await act(async () => { ending = view.call.endCall(); });
    await act(async () => { redial = view.call.startCall('test-peer'); });
    await act(async () => { write.reject(new Error('Old accept rejected')); await Promise.all([accepting, ending, redial]); });
    expect(view.call.status).toBe('offering'); expect(view.call.error).toBeNull(); expect(managers[1].cleaned).toBe(false);
    await act(async () => managers[1].config.onConnectionStateChange('connected'));
    await act(async () => { await view.call.toggleScreenShare(); });
    expect(view.call.isScreenSharing).toBe(true);
    await act(async () => oldManager.config.onScreenShareEnded());
    expect(view.call.isScreenSharing).toBe(true);
  } finally { write.resolve(); await view.close(); }
});

test('a previous receive failure cannot replace the new call error state', async () => {
  const view = await setup(), read = deferred();
  let receiving;
  try {
    await act(async () => { await view.call.startCall('test-peer'); });
    incoming.set('old-receive', read.promise);
    await act(async () => { receiving = onSignatures(['old-receive']).catch(() => undefined); });
    await act(async () => { await view.call.endCall(); });
    await act(async () => { await view.call.startCall('test-peer'); });
    await act(async () => { read.reject(new Error('Old read failed')); await receiving; });
    expect(view.call.status).toBe('offering'); expect(view.call.error).toBeNull(); expect(managers[1].cleaned).toBe(false);
  } finally { read.resolve(null); await view.close(); }
});


for (const earlyConnection of [false, true]) {
  test(`accept approval waits without consuming negotiation time${earlyConnection ? ' and preserves an early connection' : ''}`, async () => {
    const view = await setup(), write = deferred();
    let accepting;
    try {
      incoming.set('offer', {type: 'call-offer', callId: 'incoming-slow-approval', from: 'test-peer', to: 'test-caller', timestamp: Date.now(), encPubKey: 'a'.repeat(64)});
      await act(async () => { await onSignatures(['offer']); });
      sendBehavior = () => write.promise;
      await act(async () => { accepting = view.call.acceptCall(); });
      expect(view.call.status).toBe('accepting');
      await view.clock.advance(90000);
      expect(view.call.status).toBe('accepting');
      expect(view.call.error).toBeNull();
      expect(managers[0].cleaned).toBe(false);
      if (earlyConnection) {
        await act(async () => managers[0].config.onConnectionStateChange('connected'));
        expect(view.call.status).toBe('active');
      }
      let result;
      await act(async () => { write.resolve(); result = await accepting; });
      expect(result).toBe(true);
      expect(view.call.status).toBe(earlyConnection ? 'active' : 'connecting');
      if (!earlyConnection) {
        await view.clock.advance(59999);
        expect(view.call.status).toBe('connecting');
        await view.clock.advance(1);
        expect(view.call.status).toBe('idle');
        expect(view.call.error).toBe('Call connection timed out');
      }
    } finally { write.resolve(); await view.close(); }
  });
}
