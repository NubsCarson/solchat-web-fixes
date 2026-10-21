/**
 * Voice Call Encryption
 *
 * Encrypts signaling data (SDP, ICE candidates) so only the caller
 * and callee can read them. Uses NaCl box (X25519 + XSalsa20-Poly1305).
 *
 * SECURITY MODEL:
 * 1. Each user generates an ephemeral encryption keypair (no wallet signing needed)
 * 2. The PUBLIC KEY is shared in call-offer/call-accept
 * 3. The SECRET KEY stays in browser memory only
 * 4. SDP and ICE candidates are encrypted with the remote party's public key
 *
 * This provides:
 * - Privacy: SDP/ICE data is encrypted on-chain, only caller/callee can read
 * - Ephemeral keys: key generation does not require a wallet signature
 *   (publishing each on-chain signal still requires a signed transaction)
 * - Forward secrecy: New keypair each session
 */

import nacl from "tweetnacl";

/**
 * Generate a new random encryption keypair
 * No wallet signing required - fully ephemeral
 */
export function generateEncryptionKeypair(): nacl.BoxKeyPair {
  return nacl.box.keyPair();
}

/**
 * Encrypt a message for a recipient
 */
export function encryptForRecipient(
  message: string,
  recipientPublicKey: Uint8Array,
  senderSecretKey: Uint8Array,
): { encrypted: string; nonce: string } {
  const messageBytes = new TextEncoder().encode(message);
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const encrypted = nacl.box(
    messageBytes,
    nonce,
    recipientPublicKey,
    senderSecretKey,
  );

  if (!encrypted) {
    throw new Error("Encryption failed");
  }

  return {
    encrypted: uint8ArrayToBase64(encrypted),
    nonce: uint8ArrayToBase64(nonce),
  };
}

/**
 * Decrypt a message from a sender
 */
export function decryptFromSender(
  encryptedBase64: string,
  nonceBase64: string,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): string | null {
  try {
    const encrypted = base64ToUint8Array(encryptedBase64);
    const nonce = base64ToUint8Array(nonceBase64);
    const decrypted = nacl.box.open(
      encrypted,
      nonce,
      senderPublicKey,
      recipientSecretKey,
    );

    if (!decrypted) {
      return null;
    }

    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

/**
 * Encode Uint8Array to base64 string
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode base64 string to Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encode Uint8Array to hex string (for public key storage)
 */
export function uint8ArrayToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Decode hex string to Uint8Array
 */
export function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}
