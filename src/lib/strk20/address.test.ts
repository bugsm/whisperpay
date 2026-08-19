/**
 * One account, spelled two ways.
 *
 * Starknet addresses are field elements, so the same account reaches the app
 * padded to 64 hex digits from a wallet and unpadded from a link or an event
 * log. Comparing those as strings says they're different accounts, which in a
 * signing gate means refusing the person who owns the key.
 *
 * The pair below is the real recipient account from the mainnet transactions in
 * `strk20.json`, in both forms it actually appeared in — the padded one is
 * copied from a signed receipt this app produced.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  findToken,
  isValidAddress,
  normalizeAddress,
  sameAddress,
  STRK,
} from "@/lib/strk20/constants";

/** As it arrives from a wallet: `validateAndParseAddress` pads to 64 digits. */
const PADDED =
  "0x011602e87f4db482a7930163b38b8fc070eb6c3bccbb68ff78821beab4c1be41";

/** As it arrives from a payment link, and as `strk20.json` records it. */
const PLAIN =
  "0x11602e87f4db482a7930163b38b8fc070eb6c3bccbb68ff78821beab4c1be41";

/** The payer account from the same transactions — a genuinely different one. */
const OTHER =
  "0x06D77cFF6A7C46bB3ADdD1762c79DB9A2B9B7345C117b179bf68Ed11fa6683Fa";

describe("sameAddress", () => {
  it("treats the padded and unpadded forms as one account", () => {
    // The regression. These differ by a single leading zero and `===` says so.
    assert.notEqual(PADDED, PLAIN);
    assert.ok(sameAddress(PADDED, PLAIN));
    assert.ok(sameAddress(PLAIN, PADDED));
  });

  it("is unmoved by casing and surrounding whitespace", () => {
    assert.ok(sameAddress(PLAIN.toUpperCase().replace("0X", "0x"), PADDED));
    assert.ok(sameAddress(`  ${PADDED}  `, PLAIN));
  });

  it("still distinguishes different accounts", () => {
    assert.equal(sameAddress(PLAIN, OTHER), false);
    assert.equal(sameAddress(PADDED, OTHER), false);
  });

  it("treats a malformed address as matching nothing, itself included", () => {
    // A gate that let "not-an-address" match would be worse than one that
    // refused a valid owner.
    assert.equal(sameAddress("not-an-address", "not-an-address"), false);
    assert.equal(sameAddress("", ""), false);
    assert.equal(sameAddress("0x", PLAIN), false);
  });
});

describe("normalizeAddress", () => {
  it("maps both forms to one canonical string", () => {
    assert.equal(normalizeAddress(PADDED), normalizeAddress(PLAIN));
    assert.equal(normalizeAddress(PADDED), PLAIN.toLowerCase());
  });

  it("is idempotent, so re-normalizing a stored value is safe", () => {
    assert.equal(normalizeAddress(normalizeAddress(PADDED)), normalizeAddress(PADDED));
  });

  it("lowercases and unpads a mixed-case address in one step", () => {
    // `OTHER` is both mixed-case and zero-padded, which is exactly how it came
    // out of the wallet.
    assert.equal(
      normalizeAddress(OTHER),
      `0x${OTHER.slice(3).toLowerCase()}`
    );
  });
});

describe("isValidAddress accepts both forms", () => {
  it("accepts the padded form a wallet returns", () => {
    // 64 hex digits — one more than the field needs, and previously the edge
    // of the length check.
    assert.equal(PADDED.length - 2, 64);
    assert.ok(isValidAddress(PADDED));
  });

  it("accepts the unpadded form a link carries", () => {
    assert.ok(isValidAddress(PLAIN));
  });
});

describe("the gates that decide who may act", () => {
  /** The receipt-signing gate, as `Dashboard.generateReceipt` applies it. */
  const maySignReceipt = (connected: string, requestRecipient: string) =>
    sameAddress(connected, requestRecipient);

  it("lets the recipient sign when their wallet reports a padded address", () => {
    // Exactly the reported bug: request stored unpadded, wallet connected
    // padded, and the recipient was told to switch to the account they were
    // already using.
    assert.ok(maySignReceipt(PADDED, PLAIN));
  });

  it("lets them sign when the padding falls the other way", () => {
    assert.ok(maySignReceipt(PLAIN, PADDED));
  });

  it("still refuses someone else's account", () => {
    assert.equal(maySignReceipt(OTHER, PLAIN), false);
  });

  /** The "this request is addressed to you" gate in `AdoptRequest`. */
  const mayAdopt = (connected: string, requestRecipient: string) =>
    connected !== "" && sameAddress(connected, requestRecipient);

  it("offers adoption regardless of which form each side is in", () => {
    assert.ok(mayAdopt(PADDED, PLAIN));
    assert.ok(mayAdopt(PLAIN, PADDED));
    assert.equal(mayAdopt("", PLAIN), false);
    assert.equal(mayAdopt(OTHER, PLAIN), false);
  });
});

describe("findToken", () => {
  it("finds a token whether or not the address is padded", () => {
    assert.equal(findToken(STRK.address)?.symbol, "STRK");
    assert.equal(findToken(normalizeAddress(STRK.address))?.symbol, "STRK");
    assert.equal(findToken(STRK.address.toUpperCase().replace("0X", "0x"))?.symbol, "STRK");
  });

  it("returns nothing for an unknown token", () => {
    assert.equal(findToken(PLAIN), undefined);
  });
});
