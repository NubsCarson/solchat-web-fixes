import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import nacl from "tweetnacl";
import { deriveX25519Keypair, bytesToHex, multiEncrypt, multiDecrypt, passwordEncrypt, passwordDecrypt } from "iqlabs-sdk/crypto";
import { encryptDmPayload, decryptDmPayload, clearCachedKeypair, getOrDeriveKeypair } from "../lib/crypto/dm-encryption";
const text = new TextEncoder().encode("Local synthetic encryption QA \uD83D\uDDDD️");
async function key() {
  const wallet = nacl.sign.keyPair();
  const sign = async (m) => nacl.sign.detached(m, wallet.secretKey);
  const pair = await deriveX25519Keypair(sign);
  return { ...pair, hex: bytesToHex(pair.pubKey), sign };
}
test("real disposable wallet signatures recover the same DM key after cache clear", async () => {
  const a = await key();
  clearCachedKeypair();
  const first = await getOrDeriveKeypair("synthetic", a.sign);
  clearCachedKeypair();
  const again = await getOrDeriveKeypair("synthetic", a.sign);
  expect(again.pubHex).toBe(first.pubHex);
  clearCachedKeypair();
});
test("same plaintext receives fresh random encryption; sender and recipient recover unicode exactly", async () => {
  const [a, b] = await Promise.all([key(), key()]);
  const first = await encryptDmPayload(a.hex, b.hex, new TextDecoder().decode(text));
  const second = await encryptDmPayload(a.hex, b.hex, new TextDecoder().decode(text));
  expect(first).not.toBe(second);
  expect(await decryptDmPayload(b.privKey, b.hex, first)).toEqual({ text: new TextDecoder().decode(text) });
});
test("actual DM send callback never calls the writer when sender or recipient key is missing", async () => {
  const source = readFileSync(new URL("../components/friends/friends-list.tsx", import.meta.url), "utf8");
  const start = source.indexOf("writeMessage: async (payload) => {");
  const end = source.indexOf("            onBeforeSend:", start);
  const code = new Bun.Transpiler({ loader: "tsx" }).transformSync("const value={" + source.slice(start, end) + "};");
  const a = await key();
  for (const missing of ["sender", "recipient"]) {
    let writes = 0;
    const fn = new Function("chatFriend", "lookupEncryptionKey", "readConnection", "dmKeys", "encryptDmPayload", "iqlabs", "connection", "signer", "dbRootId", code + ";return value.writeMessage;")({ address: "recipient", dmSeed: "seed" }, async () => missing === "recipient" ? null : a.hex, {}, { pubHex: missing === "sender" ? null : a.hex }, encryptDmPayload, { writer: { writeConnectionRow: () => {
      writes++;
    } } }, {}, {}, "root");
    await expect(fn({ text: "must never become plaintext", id: "id", sender: "sender", timestamp: 1 })).rejects.toThrow("Encryption keys");
    expect(writes).toBe(0);
  }
});
test("SDK group envelope lets three members decrypt and rejects outsider; removing a member affects only future messages", async () => {
  const [a, b, c, d] = await Promise.all([key(), key(), key(), key()]);
  const old = await multiEncrypt([a.hex, b.hex, c.hex], text);
  for (const member of [a, b, c])
    expect(await multiDecrypt(member.privKey, member.hex, old)).toEqual(text);
  await expect(multiDecrypt(d.privKey, d.hex, old)).rejects.toThrow();
  const next = await multiEncrypt([a.hex, b.hex], text);
  await expect(multiDecrypt(c.privKey, c.hex, next)).rejects.toThrow();
  expect(await multiDecrypt(c.privKey, c.hex, old)).toEqual(text);
});
test("changing a wrapped content key fails authentication", async () => {
  const [a, b] = await Promise.all([key(), key()]);
  const box = await multiEncrypt([a.hex, b.hex], text);
  box.recipients[1].wrappedKey = (box.recipients[1].wrappedKey[0] === "0" ? "1" : "0") + box.recipients[1].wrappedKey.slice(1);
  await expect(multiDecrypt(b.privKey, b.hex, box)).rejects.toThrow();
});
test("SDK password encryption rejects wrong password and changed bytes, uses fresh salts", async () => {
  const password = "disposable QA passphrase";
  const box = await passwordEncrypt(password, text), other = await passwordEncrypt(password, text);
  expect(box.salt).not.toBe(other.salt);
  expect(await passwordDecrypt(password, box.salt, box.iv, box.ciphertext)).toEqual(text);
  await expect(passwordDecrypt("wrong", box.salt, box.iv, box.ciphertext)).rejects.toThrow();
  await expect(passwordDecrypt(password, box.salt, box.iv, (box.ciphertext[0] === "0" ? "1" : "0") + box.ciphertext.slice(1))).rejects.toThrow();
});
