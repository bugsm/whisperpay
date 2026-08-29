/**
 * Encrypting a bill so the server can hold it without being able to read it.
 *
 * A stateless bill link carries every name and every share in its own URL,
 * which makes it long enough for chat apps to truncate. The short link solves
 * the length and nothing else: the payload is encrypted in the browser, the
 * server stores opaque bytes under a random id, and the key lives in the URL
 * fragment — the one part of a URL browsers never send to a server.
 *
 * So the trade is honest in both directions. The server gains no ability to
 * read a bill; it gains the ability to lose one. That is why stateless stays
 * the default and this is opt-in.
 *
 * AES-GCM with a fresh 256-bit key and a fresh 12-byte IV per bill. Nothing
 * here reuses a key, so the usual GCM nonce-reuse hazard doesn't arise: a key
 * encrypts exactly one payload, once, and is then only ever used to decrypt it.
 */

import { base64UrlToBytes, bytesToBase64Url } from "@/lib/request/codec";

/** Thrown for anything that arrives malformed, corrupt, or simply too big. */
export class BillCryptoError extends Error {}

/** AES-GCM's standard IV length. 12 bytes, random per bill. */
const IV_BYTES = 12;

/**
 * The largest ciphertext the short-link store will hold, in base64url
 * characters.
 *
 * A full twenty-line bill encodes to roughly 1.8k characters, so 8k is ample
 * headroom and still far too small to be worth anything as free storage. The
 * limit is enforced on both sides: here, so the browser doesn't post something
 * it will only be refused for, and in the route, because the route is what an
 * attacker actually talks to.
 */
export const MAX_CIPHERTEXT_LENGTH = 8192;

/** A 12-byte IV is always exactly 16 base64url characters. */
export const IV_LENGTH = 16;

export interface EncryptedBill {
  /** base64url. Opaque — nothing outside this module may try to read it. */
  ciphertext: string;
  /** base64url of the 12 random bytes this bill was encrypted with. */
  iv: string;
}

export function generateBillKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * The key as it appears in a link fragment: 32 raw bytes, base64url, 43
 * characters. Never sent anywhere — see the module comment.
 */
export async function exportBillKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64Url(new Uint8Array(raw));
}

export async function importBillKey(fragment: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    // Copied into a fresh buffer: WebCrypto's types insist on a plain
    // `ArrayBuffer`, and the decoder's output is only known to be array-like.
    raw = new Uint8Array(base64UrlToBytes(fragment));
  } catch {
    throw new BillCryptoError("The key in this link isn't readable.");
  }
  if (raw.length !== 32) {
    throw new BillCryptoError("The key in this link is the wrong length.");
  }

  try {
    return await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, true, [
      "encrypt",
      "decrypt",
    ]);
  } catch {
    throw new BillCryptoError("The key in this link couldn't be used.");
  }
}

export async function encryptBill(
  payload: string,
  key: CryptoKey
): Promise<EncryptedBill> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(payload)
  );

  const ciphertext = bytesToBase64Url(new Uint8Array(sealed));
  if (ciphertext.length > MAX_CIPHERTEXT_LENGTH) {
    throw new BillCryptoError(
      "This bill is too large to shorten. Share the full link instead."
    );
  }

  return { ciphertext, iv: bytesToBase64Url(iv) };
}

/**
 * The reverse, with every failure surfaced as a sentence.
 *
 * A decrypt failure here is the ordinary case, not an exceptional one: a link
 * truncated in a chat app loses the end of its key, and GCM answers a wrong key
 * and a tampered ciphertext identically. Both have to reach the reader as
 * something they can act on rather than as a blank screen.
 */
export async function decryptBill(
  sealed: EncryptedBill,
  key: CryptoKey
): Promise<string> {
  if (sealed.ciphertext.length > MAX_CIPHERTEXT_LENGTH) {
    throw new BillCryptoError("This bill is larger than a bill can be.");
  }

  let iv: Uint8Array<ArrayBuffer>;
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    iv = new Uint8Array(base64UrlToBytes(sealed.iv));
    bytes = new Uint8Array(base64UrlToBytes(sealed.ciphertext));
  } catch {
    throw new BillCryptoError("This bill's stored data isn't readable.");
  }
  if (iv.length !== IV_BYTES) {
    throw new BillCryptoError("This bill's stored data isn't readable.");
  }

  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, bytes);
  } catch {
    throw new BillCryptoError(
      "This bill couldn't be decrypted with the key in the link. The link was " +
        "probably cut short when it was shared — ask for it again."
    );
  }

  return new TextDecoder().decode(plain);
}
