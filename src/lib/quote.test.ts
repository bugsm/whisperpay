/**
 * The conversion arithmetic, and the invariant it exists to protect.
 *
 * A receipt is converted **once** — the whole total — and then split with
 * `allocate`. Converting each person separately would round each of them down
 * and leave the organiser quietly carrying the difference, which is exactly the
 * bug this ordering prevents. The last case here is that property stated as a
 * test rather than as a comment.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allocate } from "@/lib/bill/allocate";
import type { FiatQuote } from "@/lib/bill/types";
import {
  fiatToTokenUnits,
  formatFiat,
  isQuoteStale,
  MAX_QUOTE_AGE_SECONDS,
  QuoteError,
  quoteAgeSeconds,
  tokenUnitsToFiat,
} from "@/lib/quote";

/** Rp 8,500 per STRK — the shape a rupiah quote actually arrives in. */
const IDR: FiatQuote = { currency: "IDR", rate: "8500", quotedAt: 1787165278 };
const DECIMALS = 18;

describe("fiat converts to token units", () => {
  it("converts a round amount", () => {
    // Rp 85,000 at Rp 8,500 per STRK is 10 STRK exactly.
    assert.equal(fiatToTokenUnits(85_000n, IDR, DECIMALS), 10n * 10n ** 18n);
  });

  it("rounds down rather than up", () => {
    // Rp 1 at Rp 8,500/STRK is 117647058823529.41… wei. The fraction is worth
    // far less than a rupiah; rounding it up would ask for more than the
    // receipt says.
    assert.equal(fiatToTokenUnits(1n, IDR, DECIMALS), 117_647_058_823_529n);
  });

  it("handles a fractional rate", () => {
    const quote: FiatQuote = { ...IDR, rate: "8500.75" };
    const units = fiatToTokenUnits(85_000n, quote, DECIMALS);
    // Slightly more rupiah per STRK means slightly less STRK for the same bill.
    assert.ok(units < 10n * 10n ** 18n);
    assert.ok(units > 9n * 10n ** 18n);
  });

  it("handles a currency with minor units", () => {
    // $1.00 at 50 cents per token is 2 tokens.
    const usd: FiatQuote = { currency: "USD", rate: "50", quotedAt: 1 };
    assert.equal(fiatToTokenUnits(100n, usd, DECIMALS), 2n * 10n ** 18n);
  });

  it("survives an extreme rate in both directions", () => {
    const cheap: FiatQuote = { ...IDR, rate: "0.00000001" };
    const dear: FiatQuote = { ...IDR, rate: "99999999" };

    assert.ok(fiatToTokenUnits(1n, cheap, DECIMALS) > 0n);
    // Even at a hundred million rupiah per token, one rupiah still buys
    // something: 18 decimals is finer than any rate a price feed reports.
    assert.ok(fiatToTokenUnits(1n, dear, DECIMALS) > 0n);
  });

  it("floors to zero rather than throwing when a unit is too coarse", () => {
    // Only reachable with a coarse token — two decimals at Rp 8,500 means one
    // rupiah is worth less than the smallest unit that exists.
    assert.equal(fiatToTokenUnits(1n, IDR, 2), 0n);
  });

  it("converts zero to zero", () => {
    assert.equal(fiatToTokenUnits(0n, IDR, DECIMALS), 0n);
  });

  it("refuses a rate that isn't one", () => {
    for (const rate of ["0", "-1", "", "abc", "8,500"]) {
      assert.throws(
        () => fiatToTokenUnits(1000n, { ...IDR, rate }, DECIMALS),
        QuoteError,
        `rate ${JSON.stringify(rate)} should be refused`
      );
    }
  });

  it("refuses a negative amount rather than inventing one", () => {
    assert.throws(() => fiatToTokenUnits(-1n, IDR, DECIMALS), QuoteError);
    assert.throws(() => tokenUnitsToFiat(-1n, IDR, DECIMALS), QuoteError);
  });
});

describe("token units convert back for display", () => {
  it("round-trips a round amount", () => {
    assert.equal(tokenUnitsToFiat(10n * 10n ** 18n, IDR, DECIMALS), 85_000n);
  });

  it("formats what a reader recognises", () => {
    assert.equal(formatFiat(85_000n, "IDR"), "Rp 85,000");
    assert.equal(formatFiat(1_234n, "USD"), "$ 12.34");
    // An unknown currency is shown plainly rather than mis-scaled.
    assert.equal(formatFiat(1_234n, "XYZ"), "1234 XYZ");
  });
});

describe("a rate ages", () => {
  it("is fresh inside the window and stale outside it", () => {
    const now = IDR.quotedAt;
    assert.equal(isQuoteStale(IDR, now), false);
    assert.equal(isQuoteStale(IDR, now + MAX_QUOTE_AGE_SECONDS), false);
    assert.equal(isQuoteStale(IDR, now + MAX_QUOTE_AGE_SECONDS + 1), true);
  });

  it("treats a rate from the future as stale", () => {
    // A clock disagrees somewhere, and "how old is this" has no useful answer.
    assert.equal(isQuoteStale(IDR, IDR.quotedAt - 1), true);
  });

  it("reports its age", () => {
    assert.equal(quoteAgeSeconds(IDR, IDR.quotedAt + 42), 42);
  });
});

describe("the parts equal the whole", () => {
  it("keeps every converted unit when a bill is split", () => {
    // The ordering that matters: convert the total once, then allocate. The
    // other way round loses a unit per person to flooring, and the organiser
    // eats the difference.
    const cases: Array<[bigint, bigint[]]> = [
      [85_000n, [30_000n, 25_000n, 30_000n]],
      [100_001n, [33_334n, 33_333n, 33_334n]],
      [1n, [1n, 0n, 0n]],
      [7_777_777n, [1n, 2n, 3n, 4n, 5n]],
    ];

    for (const [totalFiat, weights] of cases) {
      const totalUnits = fiatToTokenUnits(totalFiat, IDR, DECIMALS);
      const portions = allocate(totalUnits, weights);

      assert.equal(
        portions.reduce((sum, portion) => sum + portion, 0n),
        totalUnits,
        `splitting ${totalFiat} lost or gained a unit`
      );
      assert.ok(portions.every((portion) => portion >= 0n));
    }
  });

  it("is worse the other way round, which is why it isn't done that way", () => {
    // Converting each share separately: three shares of Rp 1 each convert to
    // 117647058823529 wei apiece, but the Rp 3 total converts to one wei more.
    const perShare = [1n, 1n, 1n].map((share) =>
      fiatToTokenUnits(share, IDR, DECIMALS)
    );
    const summed = perShare.reduce((sum, share) => sum + share, 0n);
    const converted = fiatToTokenUnits(3n, IDR, DECIMALS);

    assert.ok(summed < converted, "the shortfall this ordering avoids");
  });
});
