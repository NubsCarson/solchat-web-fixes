'use client';

/**
 * DM encryption/decryption using iqlabs-sdk crypto primitives.
 *
 * Key derivation: wallet signMessage → deterministic X25519 keypair
 * Encryption: ephemeral ECDH → HKDF → AES-256-GCM
 * Key storage: encryption pubkey stored in user profile metadata on-chain
 */

import {
  deriveX25519Keypair,
  multiEncrypt,
  multiDecrypt,
  bytesToHex,
} from 'iqlabs-sdk/crypto';
import type { MultiEncryptResult } from 'iqlabs-sdk/crypto';

export type EncryptedDmPayload = {
  m: 'dm';
  r: Array<[string, string, string, string]>;
  i: string;
  c: string;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Recipient = MultiEncryptResult['recipients'][number];

function recipientsToTuples(recipients: Recipient[]): Array<[string, string, string, string]> {
  return recipients.map((r) => [r.recipientPub, r.ephemeralPub, r.wrappedKey, r.wrapIv]);
}

function tuplesToRecipients(tuples: unknown): Recipient[] | null {
  if (!Array.isArray(tuples)) return null;
  const out: Recipient[] = [];
  for (const entry of tuples) {
    if (Array.isArray(entry) && entry.length === 4 && entry.every((v) => typeof v === 'string')) {
      out.push({ recipientPub: entry[0], ephemeralPub: entry[1], wrappedKey: entry[2], wrapIv: entry[3] });
    } else if (entry && typeof entry === 'object' && 'recipientPub' in entry) {
      out.push(entry as Recipient);
    } else {
      return null;
    }
  }
  return out;
}

// Keep only the active wallet's derived key, never another connected account's.
type DmKeypair = Awaited<ReturnType<typeof deriveX25519Keypair>> & { pubHex: string };
let cachedKeypair: DmKeypair | null = null;
let cachedWalletAddress: string | null = null;
let pendingKeypair: Promise<DmKeypair> | null = null;
let cacheGeneration = 0;

export async function getOrDeriveKeypair(
  walletAddress: string,
  signMessage: (msg: Uint8Array) => Promise<Uint8Array>,
): Promise<DmKeypair> {
  if (cachedWalletAddress !== walletAddress) {
    clearCachedKeypair();
    cachedWalletAddress = walletAddress;
  }
  if (cachedKeypair) return cachedKeypair;
  if (pendingKeypair) return pendingKeypair;

  const generation = cacheGeneration;
  const pending = (async () => {
    const pair = await deriveX25519Keypair(signMessage);
    const result = { ...pair, pubHex: bytesToHex(pair.pubKey) };
    // A signature prompt can finish after the wallet changed or disconnected.
    if (generation === cacheGeneration && cachedWalletAddress === walletAddress) {
      cachedKeypair = result;
    }
    return result;
  })();
  pendingKeypair = pending;
  try {
    return await pending;
  } finally {
    if (pendingKeypair === pending) pendingKeypair = null;
  }
}

export function clearCachedKeypair() {
  cacheGeneration += 1;
  cachedKeypair = null;
  cachedWalletAddress = null;
  pendingKeypair = null;
}

/**
 * Encrypt a DM for both sender and recipient (both can decrypt).
 * Uses multi-recipient encryption: content encrypted once, key wrapped per participant.
 */
export async function encryptDmPayload(
  senderPubHex: string,
  recipientPubHex: string,
  plainText: string,
): Promise<string> {
  if (!/^[a-f0-9]{64}$/i.test(senderPubHex) || !/^[a-f0-9]{64}$/i.test(recipientPubHex)) {
    throw new Error("Encryption keys are not ready. Reconnect your wallet and ask the recipient to initialize encryption before retrying.");
  }
  const plaintext = encoder.encode(plainText);
  const result = await multiEncrypt([senderPubHex, recipientPubHex], plaintext);

  return JSON.stringify({
    m: 'dm',
    r: recipientsToTuples(result.recipients),
    i: result.iv,
    c: result.ciphertext,
  });
}

export async function decryptDmPayload(
  privKey: Uint8Array,
  pubHex: string,
  data: string
): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(data);
    if (parsed?.m === 'dm') {
      const recipients = tuplesToRecipients(parsed.r);
      if (!recipients || !parsed.i || !parsed.c) {
        console.warn('[decryptDmPayload] malformed envelope', { hasR: !!recipients, hasI: !!parsed.i, hasC: !!parsed.c });
        return null;
      }
      const match = recipients.find((r) => r.recipientPub.toLowerCase() === pubHex.toLowerCase());
      if (!match) {
        console.warn('[decryptDmPayload] my pubHex not in recipients', { myPubHex: pubHex, recipientPubs: recipients.map((r) => r.recipientPub) });
        return null;
      }
      const plainBytes = await multiDecrypt(privKey, pubHex, { recipients, iv: parsed.i, ciphertext: parsed.c });
      const plainText = decoder.decode(plainBytes);
      try {
        return JSON.parse(plainText);
      } catch {
        // CLI encrypts plain strings directly; wrap as a message row.
        return { text: plainText };
      }
    }
    if (parsed?.enc === 'dh-multi') {
      const { r, iv, ct } = parsed;
      if (!r || !iv || !ct) return null;
      const plainBytes = await multiDecrypt(privKey, pubHex, { recipients: r, iv, ciphertext: ct });
      const plainText = decoder.decode(plainBytes);
      try {
        return JSON.parse(plainText);
      } catch {
        return { text: plainText };
      }
    }
    return null;
  } catch (err) {
    console.warn('[decryptDmPayload] exception', err);
    return null;
  }
}

export function isEncryptedDm(data: string): boolean {
  try {
    const parsed = JSON.parse(data);
    return parsed?.m === 'dm' || parsed?.enc === 'dh-multi';
  } catch {
    return false;
  }
}
