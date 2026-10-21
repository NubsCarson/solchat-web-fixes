import { BorshAccountsCoder, BorshInstructionCoder } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import iqlabs from "iqlabs-sdk";
import type { SignerInput } from "iqlabs-sdk/utils";
import { ROOT_ID_BYTES } from "@/lib/iqlabs/constants";
import { notifyGateway } from "@/lib/gateway/reader";
import { getCachedTransaction } from "@/lib/rpc/cache";
import {
  CALLS_COLUMNS,
  CALLS_TABLE_NAME,
  parseCallSignal,
  type CallSignal,
} from "./types";

const MAX_CALL_ROW_BYTES = 64 * 1024;
const MAX_CALL_CHUNKS = 80;

const seed = iqlabs.utils.toSeedBytes(CALLS_TABLE_NAME);
const root = iqlabs.contract.getDbRootPda(ROOT_ID_BYTES);
export const callsTable = iqlabs.contract.getTablePda(root, seed);

// Created by an explicit call start, never simply by opening the app.
export async function ensureCallsTable(
  connection: Connection,
  signer: SignerInput,
): Promise<void> {
  if (await connection.getAccountInfo(callsTable)) return;
  try {
    await iqlabs.writer.createTable(
      connection,
      signer,
      ROOT_ID_BYTES,
      CALLS_TABLE_NAME,
      CALLS_TABLE_NAME,
      [...CALLS_COLUMNS],
      "id",
      [],
    );
  } catch (error) {
    if (!(await connection.getAccountInfo(callsTable))) throw error;
  }
}

export async function sendSignal(
  connection: Connection,
  signer: SignerInput,
  signal: CallSignal,
): Promise<string> {
  if (signer.publicKey.toBase58() !== signal.from)
    throw new Error("Call wallet changed");
  const row = JSON.stringify({
    id: crypto.randomUUID(),
    type: signal.type,
    data: JSON.stringify(signal),
    sender: signal.from,
    timestamp: signal.timestamp,
  });
  if (new TextEncoder().encode(row).length > MAX_CALL_ROW_BYTES)
    throw new Error("Call signal is too large");
  const signature = await iqlabs.writer.writeRow(
    connection,
    signer,
    ROOT_ID_BYTES,
    CALLS_TABLE_NAME,
    row,
  );
  const receipt = (
    await connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    })
  ).value[0];
  if (
    !receipt ||
    !["confirmed", "finalized"].includes(receipt.confirmationStatus ?? "")
  )
    throw new Error("Call transaction is not confirmed");
  if (receipt.err)
    throw new Error("Call transaction failed: " + JSON.stringify(receipt.err));
  notifyGateway(callsTable.toBase58(), signature, signal.from);
  return signature;
}

export async function readCallSignal(
  connection: Connection,
  signature: string,
  context: { to: string; since: number; peer: string | null },
): Promise<CallSignal | null> {
  const { tx } = await getCachedTransaction(connection, signature);
  if (!tx) throw new Error("Call transaction is not visible yet");
  if (tx.meta?.err) return null;
  if (tx.blockTime == null)
    throw new Error("Call transaction time is not visible yet");
  if (
    tx.blockTime * 1000 < context.since - 1000 ||
    tx.blockTime * 1000 > Date.now() + 30000
  )
    return null;
  const keys = tx.transaction.message.getAccountKeys();
  const coder = new BorshInstructionCoder(iqlabs.contract.IQ_IDL);
  const layout = iqlabs.contract.IQ_IDL.instructions.find(
    (instruction) => instruction.name === "db_code_in",
  );
  const tableIndex =
    layout?.accounts.findIndex((account) => account.name === "table") ?? -1;
  const codeIns = tx.transaction.message.compiledInstructions.flatMap(
    (instruction) => {
      if (
        !keys
          .get(instruction.programIdIndex)
          ?.equals(iqlabs.contract.PROGRAM_ID)
      )
        return [];
      try {
        const decoded = coder.decode(Buffer.from(instruction.data));
        return decoded?.name.includes("code_in")
          ? [{ instruction, name: decoded.name, data: decoded.data }]
          : [];
      } catch {
        return [];
      }
    },
  );
  // The SDK decoder selects its first recognized code-in payload. Reject mixed
  // writes so a signed inventory payload cannot be substituted for the call row.
  if (
    codeIns.length !== 1 ||
    codeIns[0].name !== "db_code_in" ||
    tableIndex < 0 ||
    !keys
      .get(codeIns[0].instruction.accountKeyIndexes[tableIndex])
      ?.equals(callsTable)
  )
    return null;
  const userIndex =
    layout?.accounts.findIndex((account) => account.name === "user") ?? -1;
  const caller =
    userIndex >= 0
      ? keys
          .get(codeIns[0].instruction.accountKeyIndexes[userIndex])
          ?.toBase58()
      : null;
  const signed = tx.transaction.message.header.numRequiredSignatures;
  if (
    !caller ||
    caller === context.to ||
    !Array.from({ length: signed }, (_, index) =>
      keys.get(index)?.toBase58(),
    ).includes(caller)
  )
    return null;
  if (context.peer && caller !== context.peer) return null;
  const instructionData = codeIns[0].data as {
    metadata?: string;
    on_chain_path?: string;
  };
  if (
    typeof instructionData.metadata !== "string" ||
    instructionData.metadata.length > 8192 ||
    typeof instructionData.on_chain_path !== "string"
  )
    return null;
  let metadata;
  try {
    metadata = JSON.parse(instructionData.metadata);
  } catch {
    return null;
  }
  if (
    !metadata ||
    !Number.isInteger(metadata.total_chunks) ||
    metadata.total_chunks < 1 ||
    metadata.total_chunks > MAX_CALL_CHUNKS
  )
    return null;

  const parseRow = (payload: string): CallSignal | null => {
    if (new TextEncoder().encode(payload).length > MAX_CALL_ROW_BYTES)
      return null;
    let row;
    try {
      row = JSON.parse(payload);
    } catch {
      return null;
    }
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const signal = parseCallSignal(
      typeof row.data === "string" ? row.data : "",
    );
    if (
      !signal ||
      signal.from !== caller ||
      row.sender !== caller ||
      signal.to !== context.to
    )
      return null;
    return { ...signal, timestamp: tx.blockTime! * 1000 };
  };
  // Inline offers can be filtered entirely from the signed transaction. Chunked
  // SDP/ICE is admitted only from the peer of this wallet's current call.
  const path = instructionData.on_chain_path;
  const inline = path
    ? null
    : parseRow(typeof metadata.data === "string" ? metadata.data : "");
  if (!path && !inline) return null;
  if (path && (!context.peer || path.length > 100)) return null;
  const relationshipPda = iqlabs.contract.getConnectionTablePda(
    root,
    iqlabs.utils.deriveDmSeed(caller, context.to),
  );
  const account = await connection.getAccountInfo(relationshipPda, "confirmed");
  if (!account || !account.owner.equals(iqlabs.contract.PROGRAM_ID))
    return null;
  try {
    const relationship = new BorshAccountsCoder(iqlabs.contract.IQ_IDL).decode(
      "Connection",
      account.data,
    );
    if (
      Number(relationship.status) !== iqlabs.contract.CONNECTION_STATUS_APPROVED
    )
      return null;
  } catch {
    return null;
  }
  if (inline) return inline;
  // Keep the existing SDK chunk decoder; it is reached only for an approved
  // current peer, never for idle listeners or unrelated global table traffic.
  try {
    const decoded = await iqlabs.reader.readUserInventoryCodeInFromTx(
      tx,
      undefined,
      undefined,
      {
        maxBytes: MAX_CALL_ROW_BYTES,
        maxChunks: MAX_CALL_CHUNKS,
        maxHistoryTransactions: 120,
      },
    );
    return parseRow(decoded.data ?? "");
  } catch (error) {
    // Oversized data is a verdict, not a transient RPC outage to retry.
    if (error instanceof iqlabs.reader.ReadLimitError) return null;
    throw error;
  }
}
