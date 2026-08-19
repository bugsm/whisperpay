/**
 * The commitment that decides who may read a payment's transaction hash.
 *
 * Worth testing precisely because it's the one thing standing between a status
 * link and a payer's public deposit.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { recipientCommitment, revealTypedData } from "@/lib/request/proof";

const RECIPIENT =
  "0x11602e87f4db482a7930163b38b8fc070eb6c3bccbb68ff78821beab4c1be41";

describe("recipientCommitment", () => {
  it("is stable for the same request and address", async () => {
    const a = await recipientCommitment("abc123", RECIPIENT);
    const b = await recipientCommitment("abc123", RECIPIENT);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  it("differs per request, so one commitment can't be reused elsewhere", async () => {
    const a = await recipientCommitment("abc123", RECIPIENT);
    const b = await recipientCommitment("abc124", RECIPIENT);
    assert.notEqual(a, b);
  });

  it("differs per recipient", async () => {
    const a = await recipientCommitment("abc123", RECIPIENT);
    const b = await recipientCommitment("abc123", "0x1234");
    assert.notEqual(a, b);
  });

  it("survives the address being written differently", async () => {
    // The payer commits from the link, the recipient reveals from their wallet;
    // the two spell the same address with different padding all the time.
    const padded = await recipientCommitment("abc123", `0x0${RECIPIENT.slice(2)}`);
    const upper = await recipientCommitment("abc123", RECIPIENT.toUpperCase().replace("0X", "0x"));
    const plain = await recipientCommitment("abc123", RECIPIENT);
    assert.equal(padded, plain);
    assert.equal(upper, plain);
  });

  it("handles an installment key", async () => {
    const commitment = await recipientCommitment("abc123.11", RECIPIENT);
    assert.match(commitment, /^[0-9a-f]{64}$/);
  });
});

describe("revealTypedData", () => {
  it("names the request it authorises", () => {
    const data = revealTypedData("abc123");
    assert.equal((data.message as Record<string, string>).request, "abc123");
    assert.equal(data.primaryType, "Reveal");
  });

  it("is revision 1, which is what wallets sign today", () => {
    const data = revealTypedData("abc123");
    assert.equal(data.domain.revision, "1");
    assert.ok(data.types.StarknetDomain);
  });

  it("keeps every shortstring inside the 31-character limit", () => {
    // The longest id this app produces is 12 characters plus an installment
    // suffix; the action text is fixed. Both are felts once encoded, and a
    // shortstring that overflows can't be signed at all.
    const data = revealTypedData("abcdefghijkl.999");
    const message = data.message as Record<string, string>;
    for (const value of Object.values(message)) {
      assert.ok(value.length <= 31, `${value} is ${value.length} characters`);
    }
    for (const value of Object.values(data.domain)) {
      if (typeof value === "string") {
        assert.ok(value.length <= 31, `${value} is ${value.length} characters`);
      }
    }
  });
});
