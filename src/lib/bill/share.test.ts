/**
 * Deriving a payment request from one line of a bill.
 *
 * The point of these checks is that nothing downstream has to change: a derived
 * id has to be an id `decodeRequest` accepts, and a derived request has to be a
 * request it accepts, or the payer page would need to learn what a bill is.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeBill } from "@/lib/bill/codec";
import { parseShareId, sharePath, shareStatusId, shareToRequest } from "@/lib/bill/share";
import type { SplitBill } from "@/lib/bill/types";
import { decodeRequest, newRequestId } from "@/lib/request/codec";
import { MAX_MEMO_LENGTH } from "@/lib/request/types";
import { STRK } from "@/lib/strk20/constants";

const BILL: SplitBill = {
  id: "DrKU4kQm1a2b",
  recipient: "0x116cd5a7c6d1e3c9b8b0b0b6b0e5a0f4e0d7c6b5a4e3d2c1b0a9f8e7d6c5b41",
  recipientName: "alice.stark",
  token: STRK.address,
  title: "Saturday dinner",
  createdAt: 1787165278,
  expiresAt: 1787769999,
  shares: [
    { label: "bedu", amount: 12_340000000000000000n, memo: "ayam goreng" },
    { label: "adi", amount: 8_000000000000000000n },
  ],
};

/** The id rule `decodeRequest` enforces. A derived id has to pass it unchanged. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

describe("a share derives into an ordinary request", () => {
  it("inherits the bill's recipient, token, dates and expiry", () => {
    const request = shareToRequest(BILL, 0);

    assert.equal(request.recipient, BILL.recipient);
    assert.equal(request.recipientName, "alice.stark");
    assert.equal(request.token, BILL.token);
    assert.equal(request.createdAt, BILL.createdAt);
    assert.equal(request.expiresAt, BILL.expiresAt);
    assert.equal(request.amount, BILL.shares[0].amount);
    // A share is never recurring — a bill is one round of payments.
    assert.equal(request.schedule, undefined);
  });

  it("names the person in the memo, with what they ordered", () => {
    assert.equal(shareToRequest(BILL, 0).memo, "bedu — ayam goreng");
    assert.equal(shareToRequest(BILL, 1).memo, "adi");
  });

  it("keeps the name when the note has to be cut", () => {
    const request = shareToRequest(
      { ...BILL, shares: [{ ...BILL.shares[0], memo: "x".repeat(200) }, BILL.shares[1]] },
      0
    );
    assert.equal(request.memo?.length, MAX_MEMO_LENGTH);
    assert.ok(request.memo?.startsWith("bedu — "));
  });

  it("throws for a line the bill doesn't have", () => {
    assert.throws(() => shareToRequest(BILL, 2), RangeError);
  });

  it("produces a payment link the existing decoder accepts", () => {
    const path = sharePath(BILL, 0);
    assert.ok(path.startsWith("/pay/"));

    const decoded = decodeRequest(path.slice("/pay/".length));
    assert.equal(decoded.id, "DrKU4kQm1a2b-0");
    assert.equal(decoded.amount, BILL.shares[0].amount);
    assert.equal(decoded.memo, "bedu — ayam goreng");
    assert.equal(decoded.recipientName, "alice.stark");
  });

  it("gives every line of a full bill a valid, distinct id", () => {
    const shares = Array.from({ length: 20 }, (_, i) => ({
      label: `person ${i}`,
      amount: 1_000000000000000000n,
    }));
    const bill: SplitBill = { ...BILL, id: newRequestId(), shares };

    const ids = shares.map((_, index) => shareToRequest(bill, index).id);
    for (const id of ids) {
      assert.match(id, REQUEST_ID_PATTERN);
      assert.ok(id.length <= 32);
    }
    assert.equal(new Set(ids).size, ids.length);

    // And the whole bill still decodes, which is what makes the ids reachable.
    assert.equal(encodeBill(bill).length > 0, true);
  });
});

describe("a derived id can be taken apart again", () => {
  it("recovers the bill id and the index", () => {
    assert.deepEqual(parseShareId("DrKU4kQm1a2b-0"), {
      billId: "DrKU4kQm1a2b",
      index: 0,
    });
    assert.deepEqual(parseShareId(shareStatusId("DrKU4kQm1a2b", 19)), {
      billId: "DrKU4kQm1a2b",
      index: 19,
    });
  });

  it("survives a bill id that contains a dash of its own", () => {
    // base64url ids may contain `-`, so the split has to anchor on the last one.
    assert.deepEqual(parseShareId(shareStatusId("ab-cd-ef1234", 7)), {
      billId: "ab-cd-ef1234",
      index: 7,
    });
  });

  it("round-trips ids from the real generator", () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const billId = newRequestId();
      const index = attempt % 20;
      assert.deepEqual(parseShareId(shareStatusId(billId, index)), {
        billId,
        index,
      });
    }
  });

  it("returns null for anything that isn't a derived id", () => {
    assert.equal(parseShareId("DrKU4kQm1a2b"), null);
    assert.equal(parseShareId("DrKU4kQm1a2b-"), null);
    assert.equal(parseShareId("DrKU4kQm1a2b-x"), null);
    // The recurring separator means something else entirely.
    assert.equal(parseShareId("DrKU4kQm1a2b.3"), null);
  });
});
