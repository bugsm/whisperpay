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
  CURRENCIES,
  fiatToTokenUnits,
  findCurrency,
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

/**
 * The currency table.
 *
 * `minorDigits` is the highest-consequence number in `@/lib/quote`: a receipt's
 * amounts are carried in minor units, so an entry off by one asks everyone for
 * ten times what they ate. These pin the entries that are easy to get wrong —
 * the ones that aren't two — and the invariants that hold across all of them.
 */
describe("the currency table", () => {
  it("gives the zero-decimal currencies no minor unit", () => {
    // ISO says rupiah has two, for a sen that has not been legal tender in
    // living memory and appears on no receipt. Following the standard here
    // would inflate every Indonesian bill by a hundred.
    for (const code of ["IDR", "JPY", "KRW", "VND", "CLP"]) {
      assert.equal(findCurrency(code)?.minorDigits, 0, code);
    }
  });

  it("gives the Gulf dinars three", () => {
    for (const code of ["BHD", "KWD"]) {
      assert.equal(findCurrency(code)?.minorDigits, 3, code);
    }
  });

  it("gives everything else two", () => {
    const exceptions = new Set(["IDR", "JPY", "KRW", "VND", "CLP", "BHD", "KWD"]);
    for (const currency of Object.values(CURRENCIES)) {
      if (exceptions.has(currency.code)) continue;
      assert.equal(currency.minorDigits, 2, currency.code);
    }
  });

  it("is keyed by its own code, uppercase, and reachable case-insensitively", () => {
    for (const [key, currency] of Object.entries(CURRENCIES)) {
      assert.equal(key, currency.code);
      assert.equal(key, key.toUpperCase());
      assert.equal(findCurrency(key.toLowerCase())?.code, key);
    }
  });

  it("gives every currency something to print in front of an amount", () => {
    for (const currency of Object.values(CURRENCIES)) {
      assert.ok(currency.prefix.length > 0, currency.code);
    }
  });

  it("has no rate for a currency it doesn't carry", () => {
    // Not an oversight to be patched at the call site: the price source quotes
    // a fixed set, and a currency it won't quote can't be converted however
    // well the photo was read.
    assert.equal(findCurrency("XYZ"), undefined);
  });
});

describe("an amount formats in its own currency's units", () => {
  it("prints a zero-decimal currency as whole units", () => {
    assert.equal(formatFiat(12000n, "IDR"), "Rp 12,000");
    assert.equal(formatFiat(1200n, "JPY"), "¥ 1,200");
  });

  it("prints a two-decimal currency with its cents", () => {
    assert.equal(formatFiat(1250n, "USD"), "$ 12.50");
    assert.equal(formatFiat(800n, "EUR"), "€ 8.00");
  });

  it("prints a three-decimal currency with all three", () => {
    assert.equal(formatFiat(12500n, "BHD"), "BHD 12.500");
  });

  it("falls back to the bare code for a currency it doesn't know", () => {
    assert.equal(formatFiat(1250n, "XYZ"), "1250 XYZ");
  });
});

describe("converting from a currency that isn't rupiah", () => {
  /** $0.42 per STRK, in cents, at RATE_SCALE. */
  const USD: FiatQuote = { currency: "USD", rate: "42", quotedAt: 1787165278 };

  it("converts cents at the same scale as rupiah", () => {
    // $12.50 at $0.42 per STRK is 29.76… STRK, floored.
    const units = fiatToTokenUnits(1250n, USD, DECIMALS);
    assert.equal(units, (1250n * 10n ** 18n * 10n ** 8n) / (42n * 10n ** 8n));

    // Back again lands a cent short, and that is the rounding working rather
    // than failing: both directions floor, so a rate that doesn't divide
    // evenly loses a fraction each way. It is never made up by rounding one of
    // them up, which would ask someone for more than the receipt says.
    const back = tokenUnitsToFiat(units, USD, DECIMALS);
    assert.equal(back, 1249n);
    assert.ok(1250n - back <= 1n);
  });

  it("keeps the parts equal to the whole in a three-decimal currency", () => {
    const BHD: FiatQuote = { currency: "BHD", rate: "158", quotedAt: 1787165278 };
    const total = fiatToTokenUnits(12500n, BHD, DECIMALS);
    const parts = allocate(total, [1n, 1n, 1n]);
    assert.equal(parts.reduce((sum, part) => sum + part, 0n), total);
  });
});
