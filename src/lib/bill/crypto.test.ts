/**
 * What the short-link encryption is required to hold.
 *
 * The claim this feature makes is narrow and worth pinning: the server holds
 * bytes it cannot read, and only the key in the URL fragment turns them back
 * into a bill. So the cases that matter are the failures — a wrong key, a
 * tampered ciphertext, a link truncated by a chat app — and every one of them
 * has to come back as a `BillCryptoError` with something a reader can act on,
 * not as a rejected promise nobody catches.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeBill } from "@/lib/bill/codec";
import {
  BillCryptoError,
  decryptBill,
  encryptBill,
  exportBillKey,
  generateBillKey,
  importBillKey,
  IV_LENGTH,
  MAX_CIPHERTEXT_LENGTH,
} from "@/lib/bill/crypto";
import type { SplitBill } from "@/lib/bill/types";
import { STRK } from "@/lib/strk20/constants";

const BILL: SplitBill = {
  id: "DrKU4kQm1a2b",
  recipient: "0x116cd5a7c6d1e3c9b8b0b0b6b0e5a0f4e0d7c6b5a4e3d2c1b0a9f8e7d6c5b41",
  token: STRK.address,
  title: "Saturday dinner",
  createdAt: 1787165278,
  shares: [
    { label: "bedu", amount: 12_340000000000000000n, memo: "ayam goreng" },
    { label: "adi", amount: 8_000000000000000000n },
  ],
};

describe("a bill survives the round trip through the store", () => {
  it("comes back exactly as it went in", async () => {
    const payload = encodeBill(BILL);
    const key = await generateBillKey();

    const sealed = await encryptBill(payload, key);
    assert.equal(await decryptBill(sealed, key), payload);
  });

  it("travels as base64url, so it survives a URL and a JSON body", async () => {
    const key = await generateBillKey();
    const sealed = await encryptBill(encodeBill(BILL), key);

    assert.match(sealed.ciphertext, /^[A-Za-z0-9_-]+$/);
    assert.match(sealed.iv, /^[A-Za-z0-9_-]+$/);
    assert.equal(sealed.iv.length, IV_LENGTH);
  });

  it("uses a fresh IV every time, so the same bill never encrypts alike", async () => {
    // AES-GCM's one hard rule is never to reuse an IV with a key. Every bill
    // gets its own key here, and its own IV on top.
    const key = await generateBillKey();
    const payload = encodeBill(BILL);

    const first = await encryptBill(payload, key);
    const second = await encryptBill(payload, key);

    assert.notEqual(first.iv, second.iv);
    assert.notEqual(first.ciphertext, second.ciphertext);
  });

  it("carries the key through a link fragment and back", async () => {
    const key = await generateBillKey();
    const fragment = await exportBillKey(key);

    // 32 raw bytes, base64url, no padding.
    assert.equal(fragment.length, 43);
    assert.match(fragment, /^[A-Za-z0-9_-]+$/);

    const sealed = await encryptBill(encodeBill(BILL), key);
    const reopened = await importBillKey(fragment);
    assert.equal(await decryptBill(sealed, reopened), encodeBill(BILL));
  });

  it("keeps a full twenty-line bill inside the size limit", async () => {
    const full: SplitBill = {
      ...BILL,
      shares: Array.from({ length: 20 }, (_, index) => ({
        label: `person ${index}`,
        amount: 1_230000000000000000n,
        memo: "nasi goreng spesial",
      })),
    };
    const key = await generateBillKey();
    const sealed = await encryptBill(encodeBill(full), key);

    assert.ok(
      sealed.ciphertext.length < MAX_CIPHERTEXT_LENGTH,
      `a full bill encrypts to ${sealed.ciphertext.length} characters`
    );
  });
});

describe("nothing opens without the right key", () => {
  it("refuses a different key", async () => {
    const sealed = await encryptBill(encodeBill(BILL), await generateBillKey());
    const wrong = await generateBillKey();

    await assert.rejects(() => decryptBill(sealed, wrong), BillCryptoError);
  });

  it("refuses a tampered ciphertext", async () => {
    const key = await generateBillKey();
    const sealed = await encryptBill(encodeBill(BILL), key);

    // Flip one character. GCM authenticates, so this is detected rather than
    // decrypted into something subtly wrong — which for a list of amounts is
    // the difference that matters.
    const first = sealed.ciphertext[0] === "A" ? "B" : "A";
    const tampered = { ...sealed, ciphertext: first + sealed.ciphertext.slice(1) };

    await assert.rejects(() => decryptBill(tampered, key), BillCryptoError);
  });

  it("refuses a truncated ciphertext — the chat-app case", async () => {
    const key = await generateBillKey();
    const sealed = await encryptBill(encodeBill(BILL), key);

    await assert.rejects(
      () => decryptBill({ ...sealed, ciphertext: sealed.ciphertext.slice(0, -8) }, key),
      BillCryptoError
    );
  });

  it("refuses a wrong-length or unreadable IV", async () => {
    const key = await generateBillKey();
    const sealed = await encryptBill(encodeBill(BILL), key);

    await assert.rejects(() => decryptBill({ ...sealed, iv: "AAAA" }, key), BillCryptoError);
    await assert.rejects(
      () => decryptBill({ ...sealed, iv: "not base64!!" }, key),
      BillCryptoError
    );
  });

  it("refuses anything larger than a bill can be", async () => {
    const key = await generateBillKey();
    await assert.rejects(
      () =>
        decryptBill(
          { ciphertext: "A".repeat(MAX_CIPHERTEXT_LENGTH + 1), iv: "A".repeat(IV_LENGTH) },
          key
        ),
      BillCryptoError
    );
  });

  it("refuses a key fragment that was cut short", async () => {
    const fragment = await exportBillKey(await generateBillKey());

    await assert.rejects(() => importBillKey(fragment.slice(0, 20)), BillCryptoError);
    await assert.rejects(() => importBillKey(""), BillCryptoError);
    await assert.rejects(() => importBillKey("not base64!!"), BillCryptoError);
  });

  it("says something a reader can act on, not just that it failed", async () => {
    const sealed = await encryptBill(encodeBill(BILL), await generateBillKey());
    const wrong = await generateBillKey();
    await assert.rejects(
      () => decryptBill(sealed, wrong),
      (error: unknown) => {
        assert.ok(error instanceof BillCryptoError);
        assert.ok(error.message.length > 30, "the message has to be a sentence");
        return true;
      }
    );
  });
});
