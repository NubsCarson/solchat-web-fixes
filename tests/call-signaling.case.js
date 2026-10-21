import { beforeEach, expect, mock, test } from "bun:test";
import {
  Keypair,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import sdk from "iqlabs-sdk";
import { BorshAccountsCoder, BN } from "@coral-xyz/anchor";
import { ROOT_ID_BYTES } from "../lib/iqlabs/constants";

const sender = Keypair.generate();
const recipient = Keypair.generate().publicKey;
const outsider = Keypair.generate();
const contract = sdk.contract;
const decodeSignedPayload = sdk.reader.readUserInventoryCodeInFromTx;
const accountCoder = new BorshAccountsCoder(contract.IQ_IDL);
let relationshipStatus;
let decoded;
let transaction;
let writeError;
let tableExists;
let hydratedPayload;
let hydrationError;
const events = [];

mock.module("iqlabs-sdk", () => ({
  default: {
    ...sdk,
    reader: {
      ...sdk.reader,
      readUserInventoryCodeInFromTx: async (...args) => {
        events.push(["decode"]);
        if (hydrationError) throw hydrationError;
        return hydratedPayload === undefined
          ? decodeSignedPayload(...args)
          : { data: hydratedPayload };
      },
    },
    writer: {
      ...sdk.writer,
      createTable: async () => {
        events.push(["create"]);
        tableExists = true;
      },
      writeRow: async (...args) => {
        events.push(["write", ...args]);
        if (writeError) throw writeError;
        return "local-test-signature";
      },
    },
  },
}));
mock.module("../lib/gateway/reader", () => ({
  readCodeIn: async () => decoded,
  notifyGateway: (...args) => {
    events.push(["notify", ...args]);
  },
}));
mock.module("../lib/rpc/cache", () => ({
  getCachedTransaction: async () => ({ tx: transaction }),
}));
const { callsTable, ensureCallsTable, readCallSignal, sendSignal } =
  await import("../lib/voice/call-signaling");
const connection = {
  getSignatureStatuses: async () => ({
    value: [{ confirmationStatus: "confirmed", err: null }],
  }),
  getAccountInfo: async (address) => {
    if (address.equals(callsTable))
      return tableExists ? { data: Buffer.alloc(0) } : null;
    if (relationshipStatus === null) return null;
    return {
      owner: contract.PROGRAM_ID,
      data: await accountCoder.encode("Connection", {
        db_root_id: Buffer.from(ROOT_ID_BYTES),
        column_names: [],
        id_col: Buffer.from("id"),
        ext_keys: [],
        name: Buffer.from("dm"),
        gate: {
          mint: SystemProgram.programId,
          amount: new BN(0),
          gate_type: 0,
        },
        party_a: sender.publicKey,
        party_b: recipient,
        status: relationshipStatus,
        requester: 0,
        blocker: 255,
        last_timestamp: new BN(0),
      }),
    };
  },
};
const seed = sdk.utils.toSeedBytes("voice-calls");
const root = contract.getDbRootPda(ROOT_ID_BYTES);
const signal = () => ({
  type: "call-offer",
  callId: "local-call",
  from: sender.publicKey.toBase58(),
  to: recipient.toBase58(),
  timestamp: Date.now(),
  encPubKey: "a".repeat(64),
});
const row = (value) => ({
  id: "local-row",
  type: value.type,
  data: JSON.stringify(value),
  sender: value.from,
  timestamp: value.timestamp,
});
function writeInstruction(
  value,
  table = callsTable,
  payload = row(value),
  storage = {},
) {
  return contract.dbCodeInInstruction(
    contract.createInstructionBuilder(),
    {
      user: sender.publicKey,
      user_inventory: contract.getUserInventoryPda(sender.publicKey),
      db_root: root,
      table,
      receiver: Keypair.generate().publicKey,
    },
    {
      db_root_id: ROOT_ID_BYTES,
      table_seed: seed,
      on_chain_path: storage.path ?? "",
      metadata: JSON.stringify({
        filetype: "application/octet-stream",
        method: 0,
        filename: "call.bin",
        total_chunks: storage.chunks ?? 1,
        data: JSON.stringify(payload),
      }),
      session: null,
    },
  );
}
function response(instructions, signer = sender.publicKey) {
  const tx = new Transaction({
    feePayer: signer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(...instructions);
  return {
    slot: 1,
    blockTime: Math.floor(Date.now() / 1000),
    meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
    transaction: { message: tx.compileMessage(), signatures: ["1".repeat(64)] },
  };
}
beforeEach(() => {
  events.length = 0;
  writeError = null;
  tableExists = true;
  hydratedPayload = undefined;
  hydrationError = null;
  relationshipStatus = contract.CONNECTION_STATUS_APPROVED;
  const value = signal();
  decoded = { data: JSON.stringify(row(value)), metadata: "" };
  transaction = response([writeInstruction(value)]);
});

test("authenticated caller and IQ call-table transaction are accepted", async () => {
  expect(
    await readCallSignal(connection, "local-test-signature", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: null,
    }),
  ).toMatchObject({
    type: "call-offer",
    from: sender.publicKey.toBase58(),
    to: recipient.toBase58(),
  });
});
test("claimed caller must be a required transaction signer", async () => {
  const value = signal();
  value.from = outsider.publicKey.toBase58();
  decoded.data = JSON.stringify(row(value));
  transaction = response([writeInstruction(value)]);
  expect(
    await readCallSignal(connection, "local-test-signature", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: null,
    }),
  ).toBeNull();
});
test("failed transactions and mismatched row senders cannot drive calls", async () => {
  transaction.meta.err = { InstructionError: [0, "Custom"] };
  expect(
    await readCallSignal(connection, "local-test-signature", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: null,
    }),
  ).toBeNull();
  transaction.meta.err = null;
  const value = signal();
  const payload = row(value);
  payload.sender = outsider.publicKey.toBase58();
  transaction = response([writeInstruction(value, callsTable, payload)]);
  expect(
    await readCallSignal(connection, "local-test-signature", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: null,
    }),
  ).toBeNull();
});
test("unrelated programs and other IQ tables are rejected", async () => {
  const value = signal();
  transaction = response([
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [{ pubkey: callsTable, isSigner: false, isWritable: false }],
      data: Buffer.alloc(0),
    }),
  ]);
  expect(
    await readCallSignal(connection, "local-test-signature", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: null,
    }),
  ).toBeNull();
  transaction = response([
    writeInstruction(value, Keypair.generate().publicKey),
  ]);
  expect(
    await readCallSignal(connection, "local-test-signature", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: null,
    }),
  ).toBeNull();
});
test("call-table address in an unrelated instruction is not a call-table write", async () => {
  const value = signal();
  transaction = response([
    writeInstruction(value, Keypair.generate().publicKey),
    new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [{ pubkey: callsTable, isSigner: false, isWritable: false }],
      data: Buffer.alloc(0),
    }),
  ]);
  expect(
    await readCallSignal(connection, "local-test-signature", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: null,
    }),
  ).toBeNull();
});
test("gateway cannot substitute a different signal for signed on-chain payload", async () => {
  const replacement = signal();
  replacement.callId = "forged-call";
  replacement.encPubKey = "b".repeat(64);
  decoded.data = JSON.stringify(row(replacement));
  expect(
    await readCallSignal(connection, "local-test-signature", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: null,
    }),
  ).toMatchObject({ callId: "local-call", encPubKey: "a".repeat(64) });
});
test("write uses the existing IQ table and notifies only after successful submission", async () => {
  const value = signal();
  expect(await sendSignal(connection, sender, value)).toBe(
    "local-test-signature",
    { to: recipient.toBase58(), since: Date.now() - 30000, peer: null },
  );
  expect(events.map((event) => event[0])).toEqual(["write", "notify"]);
  expect(events[0][4]).toBe("voice-calls");
  expect(JSON.parse(events[0][5])).toMatchObject({
    sender: value.from,
    data: JSON.stringify(value),
  });
  expect(events[1]).toEqual([
    "notify",
    callsTable.toBase58(),
    "local-test-signature",
    value.from,
  ]);
  events.length = 0;
  writeError = Error("local send failed");
  await expect(sendSignal(connection, sender, value)).rejects.toThrow(
    "local send failed",
  );
  expect(events.map((event) => event[0])).toEqual(["write"]);
});
test("changed signer is rejected before a write or notify", async () => {
  await expect(sendSignal(connection, outsider, signal())).rejects.toThrow(
    "Call wallet changed",
  );
  expect(events).toEqual([]);
});
test("table initialization checks existing account before issuing create", async () => {
  await ensureCallsTable(connection, sender);
  expect(events).toEqual([]);
  tableExists = false;
  await ensureCallsTable(connection, sender);
  expect(events.map((event) => event[0])).toEqual(["create"]);
});

test("multiple IQ writes are not accepted as one unambiguous call signal", async () => {
  const value = signal();
  transaction = response([
    writeInstruction(value),
    writeInstruction({ ...value, callId: "other-call" }),
  ]);
  expect(
    await readCallSignal(connection, "local-test-signature", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: null,
    }),
  ).toBeNull();
});
test("null decoded rows are rejected without aborting the signal batch", async () => {
  const value = signal();
  transaction = response([writeInstruction(value, callsTable, null)]);
  expect(
    await readCallSignal(connection, "local-test-signature", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: null,
    }),
  ).toBeNull();
});

test("another code-in payload before the call-table write cannot replace its signal", async () => {
  const original = signal();
  const replacement = { ...original, callId: "unrelated-inventory-call" };
  const inventory = contract.userInventoryCodeInInstruction(
    contract.createInstructionBuilder(),
    {
      user: sender.publicKey,
      user_inventory: contract.getUserInventoryPda(sender.publicKey),
      receiver: Keypair.generate().publicKey,
    },
    {
      on_chain_path: "",
      metadata: JSON.stringify({
        method: 0,
        total_chunks: 1,
        data: JSON.stringify(row(replacement)),
      }),
      session: null,
    },
  );
  transaction = response([inventory, writeInstruction(original)]);
  const decodedSignal = await readCallSignal(
    connection,
    "local-test-signature",
    { to: recipient.toBase58(), since: Date.now() - 30000, peer: null },
  );
  expect(
    decodedSignal === null || decodedSignal.callId === original.callId,
  ).toBe(true);
});

test("a temporarily unavailable transaction is retriable rather than an invalid signal", async () => {
  transaction = null;
  await expect(
    readCallSignal(connection, "not-visible-yet", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: null,
    }),
  ).rejects.toThrow();
});

test("call-table address matches the seed normalization used by the SDK writer", () => {
  expect(callsTable.toBase58()).toBe(
    contract.getTablePda(root, sdk.utils.toSeedBytes("voice-calls")).toBase58(),
  );
});
test("failed on-chain SDK receipt is never announced as a successful call signal", async () => {
  const failed = {
    ...connection,
    getSignatureStatuses: async () => ({
      value: [
        {
          confirmationStatus: "confirmed",
          err: { InstructionError: [0, "Custom"] },
        },
      ],
    }),
  };
  await expect(sendSignal(failed, sender, signal())).rejects.toThrow(
    "Call transaction failed",
  );
  expect(events.some((event) => event[0] === "notify")).toBe(false);
});

test("blocked, pending, and unknown wallets cannot ring the global call popup", async () => {
  for (const status of [
    null,
    contract.CONNECTION_STATUS_PENDING,
    contract.CONNECTION_STATUS_BLOCKED,
  ]) {
    relationshipStatus = status;
    expect(
      await readCallSignal(connection, "local-test-signature", {
        to: recipient.toBase58(),
        since: Date.now() - 30000,
        peer: null,
      }),
    ).toBeNull();
  }
});

test("stale call transactions are dropped before payload hydration", async () => {
  transaction.blockTime = Math.floor(Date.now() / 1000) - 120;
  expect(
    await readCallSignal(connection, "stale-call", {
      to: recipient.toBase58(),
      peer: null,
      since: Date.now() - 30000,
    }),
  ).toBeNull();
  expect(events.some(([event]) => event === "decode")).toBe(false);
});

test("an unapproved caller cannot trigger payload hydration", async () => {
  relationshipStatus = contract.CONNECTION_STATUS_BLOCKED;
  expect(
    await readCallSignal(connection, "blocked-call", {
      to: recipient.toBase58(),
      peer: null,
      since: Date.now() - 30000,
    }),
  ).toBeNull();
  expect(events.some(([event]) => event === "decode")).toBe(false);
});

test("reader rejects a call addressed to another recipient", async () => {
  expect(
    await readCallSignal(connection, "other-recipient", {
      to: outsider.publicKey.toBase58(),
      peer: null,
      since: Date.now() - 30000,
    }),
  ).toBeNull();
});

test("idle or unrelated wallets never hydrate a chunked call payload", async () => {
  const value = signal();
  transaction = response([
    writeInstruction(value, callsTable, row(value), {
      path: Keypair.generate().publicKey.toBase58(),
      chunks: 12,
    }),
  ]);
  for (const peer of [null, outsider.publicKey.toBase58()]) {
    expect(
      await readCallSignal(connection, "chunked-call", {
        to: recipient.toBase58(),
        since: Date.now() - 30000,
        peer,
      }),
    ).toBeNull();
  }
  expect(events.some(([event]) => event === "decode")).toBe(false);
});

test("invalid or excessive declared chunk counts are rejected before hydration", async () => {
  const value = signal();
  for (const chunks of [-1, 0, 1.5, 81, 1000000, "12"]) {
    transaction = response([
      writeInstruction(value, callsTable, row(value), {
        path: Keypair.generate().publicKey.toBase58(),
        chunks,
      }),
    ]);
    expect(
      await readCallSignal(connection, "invalid-chunks", {
        to: recipient.toBase58(),
        since: Date.now() - 30000,
        peer: sender.publicKey.toBase58(),
      }),
    ).toBeNull();
  }
  expect(events.some(([event]) => event === "decode")).toBe(false);
});

test("an approved current peer can hydrate session SDP within the call size limit", async () => {
  const value = {
    ...signal(),
    type: "sdp-offer",
    encrypted: true,
    sdp: "ciphertext",
    nonce: "nonce",
  };
  transaction = response([
    writeInstruction(value, callsTable, row(value), {
      path: Keypair.generate().publicKey.toBase58(),
      chunks: 12,
    }),
  ]);
  hydratedPayload = JSON.stringify(row(value));
  expect(
    await readCallSignal(connection, "peer-sdp", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: sender.publicKey.toBase58(),
    }),
  ).toMatchObject({ type: "sdp-offer", sdp: "ciphertext" });
  expect(events.filter(([event]) => event === "decode")).toHaveLength(1);
});

test("a blocked current peer cannot hydrate a session payload", async () => {
  const value = signal();
  relationshipStatus = contract.CONNECTION_STATUS_BLOCKED;
  transaction = response([
    writeInstruction(value, callsTable, row(value), {
      path: Keypair.generate().publicKey.toBase58(),
      chunks: 12,
    }),
  ]);
  expect(
    await readCallSignal(connection, "blocked-session", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: sender.publicKey.toBase58(),
    }),
  ).toBeNull();
  expect(events.some(([event]) => event === "decode")).toBe(false);
});

test("outbound call rows over 64 KiB are rejected before any write", async () => {
  await expect(
    sendSignal(connection, sender, {
      ...signal(),
      type: "sdp-offer",
      sdp: "x".repeat(64 * 1024),
    }),
  ).rejects.toThrow("Call signal is too large");
  expect(events).toEqual([]);
});

test("an oversized decoded session row is rejected after the existing SDK reader", async () => {
  const value = signal();
  transaction = response([
    writeInstruction(value, callsTable, row(value), {
      path: Keypair.generate().publicKey.toBase58(),
      chunks: 12,
    }),
  ]);
  hydratedPayload = JSON.stringify(
    row({ ...value, sdp: "x".repeat(64 * 1024) }),
  );
  expect(
    await readCallSignal(connection, "oversized-session", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: sender.publicKey.toBase58(),
    }),
  ).toBeNull();
  expect(events.filter(([event]) => event === "decode")).toHaveLength(1);
});

test("a reader budget verdict is discarded rather than retried as an RPC outage", async () => {
  const value = signal();
  transaction = response([
    writeInstruction(value, callsTable, row(value), {
      path: Keypair.generate().publicKey.toBase58(),
      chunks: 12,
    }),
  ]);
  hydrationError = new sdk.reader.ReadLimitError("maxHistoryTransactions");
  expect(
    await readCallSignal(connection, "budget-verdict", {
      to: recipient.toBase58(),
      since: Date.now() - 30000,
      peer: sender.publicKey.toBase58(),
    }),
  ).toBeNull();
  expect(events.filter(([event]) => event === "decode")).toHaveLength(1);
});
test("confirmed chain time determines offer freshness after slow wallet signing", async () => {
  const value = { ...signal(), timestamp: Date.now() - 120000 };
  transaction = response([writeInstruction(value)]);
  const result = await readCallSignal(connection, "slow-wallet", {
    to: recipient.toBase58(),
    since: Date.now() - 30000,
    peer: null,
  });
  expect(result).not.toBeNull();
  expect(result.timestamp).toBe(transaction.blockTime * 1000);
});
