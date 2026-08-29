/**
 * What a bill link is allowed to contain.
 *
 * A bill payload arrives from whoever sent the link, exactly like a request
 * payload, and it carries more surface: a list of lines, each with its own
 * label and amount. So the adversarial half of this file matters more than the
 * round trip — every case below is a payload a build without these checks would
 * have rendered.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { billPath, decodeBill, encodeBill, BillDecodeError } from "@/lib/bill/codec";
import { MAX_SHARES, type SplitBill } from "@/lib/bill/types";
import { bytesToBase64Url } from "@/lib/request/codec";
import { sameAddress, STRK } from "@/lib/strk20/constants";

const RECIPIENT =
  "0x0116cd5a7c6d1e3c9b8b0b0b6b0e5a0f4e0d7c6b5a4e3d2c1b0a9f8e7d6c5b41";
/** Same account, unpadded — what `normalizeAddress` turns the above into. */
const RECIPIENT_NORMAL =
  "0x116cd5a7c6d1e3c9b8b0b0b6b0e5a0f4e0d7c6b5a4e3d2c1b0a9f8e7d6c5b41";

const BILL: SplitBill = {
  id: "DrKU4kQm1a2b",
  recipient: RECIPIENT,
  token: STRK.address,
  title: "Saturday dinner",
  createdAt: 1787165278,
  expiresAt: 1787769999,
  shares: [
    { label: "bedu", amount: 12_340000000000000000n, memo: "ayam goreng" },
    { label: "adi", amount: 8_000000000000000000n, memo: "es teh" },
    { label: "sari", amount: 15_500000000000000000n },
  ],
};

/** Hand-built payloads, for the cases `encodeBill` would never produce. */
function payload(wire: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(wire)));
}

function wireOf(bill: SplitBill = BILL): Record<string, unknown> {
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(encodeBill(bill).replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0)
      )
    )
  );
}

describe("bill codec round trip", () => {
  it("returns what went in, with addresses normalized", () => {
    const decoded = decodeBill(encodeBill(BILL));

    assert.equal(decoded.id, BILL.id);
    assert.equal(decoded.recipient, RECIPIENT_NORMAL);
    // Normalized on the way out, like every other address in the app.
    assert.ok(sameAddress(decoded.token, STRK.address));
    assert.equal(decoded.title, "Saturday dinner");
    assert.equal(decoded.createdAt, BILL.createdAt);
    assert.equal(decoded.expiresAt, BILL.expiresAt);
    assert.deepEqual(
      decoded.shares.map((share) => [share.label, share.amount, share.memo]),
      [
        ["bedu", 12_340000000000000000n, "ayam goreng"],
        ["adi", 8_000000000000000000n, "es teh"],
        ["sari", 15_500000000000000000n, undefined],
      ]
    );
  });

  it("keeps amounts exact through the string round trip", () => {
    const wei = 999_999999999999999n;
    const decoded = decodeBill(
      encodeBill({
        ...BILL,
        shares: [
          { label: "a", amount: wei },
          { label: "b", amount: 1n },
        ],
      })
    );
    assert.equal(decoded.shares[0].amount, wei);
    assert.equal(decoded.shares[1].amount, 1n);
  });

  it("carries an optional .stark label and a fiat quote", () => {
    const decoded = decodeBill(
      encodeBill({
        ...BILL,
        recipientName: "alice.stark",
        quote: { currency: "IDR", rate: "8500", quotedAt: 1787165278 },
      })
    );
    assert.equal(decoded.recipientName, "alice.stark");
    assert.deepEqual(decoded.quote, {
      currency: "IDR",
      rate: "8500",
      quotedAt: 1787165278,
    });
  });

  it("omits absent optional fields rather than encoding nulls", () => {
    const wire = wireOf({
      ...BILL,
      title: undefined,
      expiresAt: undefined,
    });
    assert.ok(!("m" in wire));
    assert.ok(!("e" in wire));
    assert.ok(!("n" in wire));
    assert.ok(!("p" in wire));
  });

  it("does not put a total on the wire — it is computed on read", () => {
    // Two sources of truth in an attacker-supplied payload is one too many.
    assert.deepEqual(Object.keys(wireOf()).sort(), ["c", "e", "h", "i", "m", "r", "t", "v"]);
  });

  it("addresses the organiser page by payload", () => {
    const encoded = encodeBill(BILL);
    assert.equal(billPath(encoded), `/bill/${encoded}`);
  });
});

describe("bill codec refuses what it cannot fully read", () => {
  const base = () => wireOf();

  function rejects(name: string, mutate: (wire: Record<string, unknown>) => void) {
    it(name, () => {
      const wire = base();
      mutate(wire);
      assert.throws(() => decodeBill(payload(wire)), BillDecodeError);
    });
  }

  it("rejects a payload that isn't base64url", () => {
    assert.throws(() => decodeBill("not a payload!"), BillDecodeError);
  });

  it("rejects base64url that isn't JSON", () => {
    assert.throws(
      () => decodeBill(bytesToBase64Url(new TextEncoder().encode("{nope"))),
      BillDecodeError
    );
  });

  it("rejects JSON that isn't an object", () => {
    assert.throws(() => decodeBill(payload([1, 2, 3])), BillDecodeError);
    assert.throws(() => decodeBill(payload("a string")), BillDecodeError);
  });

  // A future version has to be refused outright: reading v4 with v3's rules is
  // how a link comes out meaning something its author never wrote.
  rejects("rejects a newer version", (wire) => {
    wire.v = 4;
  });
  rejects("rejects a request payload's version", (wire) => {
    wire.v = 1;
  });

  rejects("rejects a missing id", (wire) => {
    delete wire.i;
  });
  rejects("rejects an id with characters outside base64url", (wire) => {
    wire.i = "has spaces";
  });

  rejects("rejects an invalid recipient", (wire) => {
    wire.r = "0xnothex";
  });
  rejects("rejects the zero address", (wire) => {
    wire.r = "0x0";
  });
  rejects("rejects an unsupported token", (wire) => {
    wire.t = "0x1234";
  });
  rejects("rejects a missing creation time", (wire) => {
    delete wire.c;
  });
  rejects("rejects a negative expiry", (wire) => {
    wire.e = -1;
  });
  rejects("rejects a title past the limit", (wire) => {
    wire.m = "x".repeat(61);
  });
  rejects("rejects a recipient name that isn't a .stark domain", (wire) => {
    wire.n = "alice.eth";
  });
  rejects("rejects a malformed fiat quote", (wire) => {
    wire.p = { c: "IDR", r: "not a rate", q: 1787165278 };
  });
  rejects("rejects a fiat quote with no timestamp", (wire) => {
    wire.p = { c: "IDR", r: "8500" };
  });

  rejects("rejects shares that aren't a list", (wire) => {
    wire.h = { l: "bedu", a: "1" };
  });
  rejects("rejects an empty bill", (wire) => {
    wire.h = [];
  });
  rejects("rejects a bill of one — that's a payment request", (wire) => {
    wire.h = [{ l: "bedu", a: "1000" }];
  });
  rejects(`rejects more than ${MAX_SHARES} shares`, (wire) => {
    wire.h = Array.from({ length: MAX_SHARES + 1 }, (_, i) => ({
      l: `p${i}`,
      a: "1000",
    }));
  });
  rejects("rejects a share that isn't an object", (wire) => {
    wire.h = [{ l: "bedu", a: "1000" }, "adi"];
  });
  rejects("rejects an empty label", (wire) => {
    wire.h = [
      { l: "   ", a: "1000" },
      { l: "adi", a: "1000" },
    ];
  });
  rejects("rejects a label past the limit", (wire) => {
    wire.h = [
      { l: "x".repeat(25), a: "1000" },
      { l: "adi", a: "1000" },
    ];
  });
  rejects("rejects a zero amount", (wire) => {
    wire.h = [
      { l: "bedu", a: "0" },
      { l: "adi", a: "1000" },
    ];
  });
  rejects("rejects a negative amount", (wire) => {
    wire.h = [
      { l: "bedu", a: "-1000" },
      { l: "adi", a: "1000" },
    ];
  });
  rejects("rejects an amount that isn't digits", (wire) => {
    wire.h = [
      { l: "bedu", a: "1e18" },
      { l: "adi", a: "1000" },
    ];
  });
  rejects("rejects an amount given as a number", (wire) => {
    wire.h = [
      { l: "bedu", a: 1000 },
      { l: "adi", a: "1000" },
    ];
  });
  rejects("rejects an implausible amount", (wire) => {
    wire.h = [
      { l: "bedu", a: (2n ** 128n).toString() },
      { l: "adi", a: "1000" },
    ];
  });
  rejects("rejects a total that overflows a plausible amount", (wire) => {
    // Every line is individually fine; only the sum gives it away.
    const each = (2n ** 128n / 4n).toString();
    wire.h = [
      { l: "a", a: each },
      { l: "b", a: each },
      { l: "c", a: each },
      { l: "d", a: each },
    ];
  });
  rejects("rejects a note past the memo limit", (wire) => {
    wire.h = [
      { l: "bedu", a: "1000", m: "x".repeat(141) },
      { l: "adi", a: "1000" },
    ];
  });

  it("trims a label rather than carrying the whitespace into a link", () => {
    const wire = base();
    wire.h = [
      { l: "  bedu  ", a: "1000" },
      { l: "adi", a: "1000" },
    ];
    assert.equal(decodeBill(payload(wire)).shares[0].label, "bedu");
  });
});
