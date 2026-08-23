/**
 * The signed receipt format.
 *
 * The load-bearing test here is the one asserting what the payload *doesn't*
 * contain. Everything else about this feature is a convenience; leaving the
 * amount out of the signed message is the honesty claim the README makes, and
 * a future field added carelessly would break it silently.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RECEIPT_CLAIM,
  RECEIPT_VERSION,
  decodeReceipt,
  encodeReceipt,
  parseReceipt,
  receiptTypedData,
  signatureParts,
  type Receipt,
} from "@/lib/request/receipt";

const RECIPIENT =
  "0x11602e87f4db482a7930163b38b8fc070eb6c3bccbb68ff78821beab4c1be41";

const receipt = (overrides: Partial<Receipt> = {}): Receipt => ({
  version: RECEIPT_VERSION,
  request: "DrKU4kQm1a2b",
  claim: RECEIPT_CLAIM,
  issuedAt: 1787165278,
  recipient: RECIPIENT,
  signature: ["0x1", "0x2"],
  ...overrides,
});

describe("receiptTypedData — what gets signed", () => {
  it("states the claim and the request", () => {
    const data = receiptTypedData("DrKU4kQm1a2b", 1787165278);
    const message = data.message as Record<string, unknown>;
    assert.equal(message.claim, RECEIPT_CLAIM);
    assert.equal(message.request, "DrKU4kQm1a2b");
    assert.equal(data.primaryType, "Receipt");
    assert.equal(data.domain.revision, "1");
  });

  it("carries no amount, no token, no payer and no transaction", () => {
    // The point of the feature. A receipt that quoted the amount would publish
    // the one number the pool exists to hide, to everyone it's ever shown to.
    const data = receiptTypedData("DrKU4kQm1a2b", 1787165278);
    const fields = data.types.Receipt.map((field) => field.name);
    assert.deepEqual(fields, ["claim", "request", "issuedAt"]);

    const serialised = JSON.stringify(data).toLowerCase();
    for (const forbidden of ["amount", "token", "payer", "sender", "txhash"]) {
      assert.ok(
        !serialised.includes(forbidden),
        `signed payload must not mention "${forbidden}"`
      );
    }
  });

  it("keeps shortstrings inside the 31-character limit", () => {
    const data = receiptTypedData("abcdefghijkl.999", 1787165278);
    const message = data.message as Record<string, unknown>;
    assert.ok(String(message.claim).length <= 31);
    assert.ok(String(message.request).length <= 31);
  });

  it("changes with the request, so a signature can't be moved between them", () => {
    const a = JSON.stringify(receiptTypedData("aaaaaaaaaaaa", 1787165278));
    const b = JSON.stringify(receiptTypedData("bbbbbbbbbbbb", 1787165278));
    assert.notEqual(a, b);
  });
});

describe("parseReceipt — reading someone else's artifact", () => {
  it("accepts a well-formed receipt", () => {
    assert.deepEqual(parseReceipt(receipt()), receipt());
  });

  it("rejects an altered claim", () => {
    // Nobody gets to sign a bespoke sentence and have it read as a receipt.
    assert.equal(parseReceipt(receipt({ claim: "Paid in cash, twice" })), null);
  });

  it("rejects a smuggled amount by ignoring it entirely", () => {
    const parsed = parseReceipt({ ...receipt(), amount: "1000" });
    assert.ok(parsed);
    assert.ok(!("amount" in parsed));
  });

  it("rejects an unknown version", () => {
    assert.equal(parseReceipt(receipt({ version: 2 })), null);
  });

  it("rejects a bad recipient address", () => {
    assert.equal(parseReceipt(receipt({ recipient: "0x0" })), null);
    assert.equal(parseReceipt(receipt({ recipient: "nonsense" })), null);
  });

  it("rejects a malformed request id", () => {
    assert.equal(parseReceipt(receipt({ request: "../../etc" })), null);
    assert.equal(parseReceipt(receipt({ request: "" })), null);
  });

  it("accepts an installment id", () => {
    assert.ok(parseReceipt(receipt({ request: "DrKU4kQm1a2b.7" })));
  });

  it("rejects a missing or empty signature", () => {
    assert.equal(parseReceipt(receipt({ signature: [] })), null);
    assert.equal(parseReceipt({ ...receipt(), signature: undefined }), null);
  });

  it("rejects a non-integer timestamp", () => {
    assert.equal(parseReceipt(receipt({ issuedAt: 1.5 })), null);
    assert.equal(parseReceipt(receipt({ issuedAt: -1 })), null);
  });

  it("rejects junk", () => {
    assert.equal(parseReceipt(null), null);
    assert.equal(parseReceipt("receipt"), null);
    assert.equal(parseReceipt({}), null);
  });
});

describe("encodeReceipt / decodeReceipt", () => {
  it("round-trips through a link", () => {
    const encoded = encodeReceipt(receipt());
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(decodeReceipt(encoded), receipt());
  });

  it("returns null for a damaged link rather than throwing", () => {
    assert.equal(decodeReceipt("not-valid-base64!!"), null);
    assert.equal(decodeReceipt(""), null);
  });

  it("returns null when the payload decodes but isn't a receipt", () => {
    const encoded = encodeReceipt({ ...receipt(), claim: "whatever" } as Receipt);
    assert.equal(decodeReceipt(encoded), null);
  });
});

describe("signatureParts — refusing to build a receipt nobody can check", () => {
  it("keeps an array of felts as it is", () => {
    assert.deepEqual(signatureParts(["0x1", "0x2"]), ["0x1", "0x2"]);
  });

  it("keeps a longer array, for accounts that sign with more than two felts", () => {
    assert.deepEqual(signatureParts(["0x1", "0x2", "0x3"]), ["0x1", "0x2", "0x3"]);
  });

  it("normalises an r/s pair to hex felts", () => {
    assert.deepEqual(signatureParts({ r: 255n, s: 16n }), ["0xff", "0x10"]);
  });

  it("rejects an empty array rather than passing it off as a signature", () => {
    // The bug this guards: an empty array survived all the way to the
    // verifier's screen, where the receipt was refused as malformed — long
    // after the recipient had handed it over.
    assert.equal(signatureParts([]), null);
  });

  it("rejects a shape it doesn't understand", () => {
    assert.equal(signatureParts(undefined), null);
    assert.equal(signatureParts(null), null);
    assert.equal(signatureParts("0xdeadbeef"), null);
    assert.equal(signatureParts({ signature: ["0x1"] }), null);
  });

  it("rejects an r/s pair that isn't numeric", () => {
    assert.equal(signatureParts({ r: "nope", s: "also nope" }), null);
  });

  it("never returns something parseReceipt would refuse", () => {
    // The two must agree, or a receipt can be assembled and then rejected.
    for (const input of [["0x1", "0x2"], { r: 1n, s: 2n }]) {
      const parts = signatureParts(input);
      assert.ok(parts);
      assert.ok(parseReceipt(receipt({ signature: parts })));
    }
  });
});
