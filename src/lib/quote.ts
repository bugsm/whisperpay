/**
 * Converting a receipt's rupiah into the STRK a link actually asks for.
 *
 * Everything here is display context with one exception, and the exception is
 * the point: the conversion happens **once**, when the bill is minted, and the
 * number that comes out is the number in the link. A bill is not a
 * fiat-denominated invoice that floats with the price. If STRK moves between
 * minting and paying, what gets paid is the same amount of STRK.
 *
 * That is a deliberate limit, not an oversight. Making it truly
 * fiat-denominated would mean the payload carried a rate to be re-fetched at
 * payment time — which puts a price source in the payment path and breaks the
 * one property everything else here is built on: a link is payable with no
 * server in the loop.
 *
 * All arithmetic is `bigint`, in the smallest unit of both currencies. No
 * `number` touches a money path, here or anywhere else in this codebase.
 */

import { formatDisplay, parseUnits } from "@/lib/amount";
import type { FiatQuote } from "@/lib/bill/types";

export class QuoteError extends Error {}

/**
 * Decimal places kept on a rate string.
 *
 * A rate arrives as "8500" or "8500.25" and has to become a `bigint` to divide
 * with. Eight places is far finer than any price feed reports and leaves the
 * products well inside a `bigint`'s comfort — which is unbounded, so the real
 * constraint is only that the same scale is used in both directions.
 */
export const RATE_SCALE = 8;

/**
 * How stale a rate may be when a bill is minted.
 *
 * Ten minutes. A stale rate locked into a link is a mistake that can't be taken
 * back — the link is already in someone's chat — so the mint is refused rather
 * than quietly using the last figure that happened to be in hand.
 */
export const MAX_QUOTE_AGE_SECONDS = 600;

export interface Currency {
  code: string;
  /**
   * Digits in the currency's minor unit. Zero for rupiah: there is no
   * subdivision of a rupiah in practice, so its minor unit *is* the rupiah.
   */
  minorDigits: number;
  /** What goes in front of the number. */
  prefix: string;
}

/**
 * Currencies a receipt may be denominated in.
 *
 * Rupiah first because that is what this feature was built for. Every entry
 * needs its `minorDigits` right or every amount in it is off by a factor of a
 * hundred, so the list stays short and deliberate rather than generated.
 */
export const CURRENCIES: Record<string, Currency> = {
  IDR: { code: "IDR", minorDigits: 0, prefix: "Rp" },
  USD: { code: "USD", minorDigits: 2, prefix: "$" },
};

export const DEFAULT_CURRENCY = CURRENCIES.IDR;

export function findCurrency(code: string): Currency | undefined {
  return CURRENCIES[code.toUpperCase()];
}

/** The rate as a `bigint`, scaled by `RATE_SCALE`. Throws on anything unusable. */
function scaledRate(quote: FiatQuote): bigint {
  let rate: bigint;
  try {
    rate = parseUnits(quote.rate, RATE_SCALE);
  } catch {
    throw new QuoteError(`"${quote.rate}" isn't a usable exchange rate.`);
  }
  if (rate <= 0n) {
    throw new QuoteError("An exchange rate has to be greater than zero.");
  }
  return rate;
}

/**
 * Fiat minor units → the token's smallest unit, rounded **down**.
 *
 * Down rather than nearest, and that direction is chosen: the rounded-off
 * fraction is worth less than a millionth of a rupiah, and rounding up would
 * mean asking each person for infinitesimally more than the receipt says. The
 * lost units never go missing — a whole bill is converted once and then split
 * with `allocate`, which is what keeps the parts equal to the whole.
 */
export function fiatToTokenUnits(
  fiatMinor: bigint,
  quote: FiatQuote,
  decimals: number
): bigint {
  if (fiatMinor < 0n) {
    throw new QuoteError("Cannot convert a negative amount.");
  }
  return (fiatMinor * 10n ** BigInt(decimals) * 10n ** BigInt(RATE_SCALE)) / scaledRate(quote);
}

/** The other direction, for showing a token amount as the money someone knows. */
export function tokenUnitsToFiat(
  units: bigint,
  quote: FiatQuote,
  decimals: number
): bigint {
  if (units < 0n) {
    throw new QuoteError("Cannot convert a negative amount.");
  }
  return (
    (units * scaledRate(quote)) /
    (10n ** BigInt(decimals) * 10n ** BigInt(RATE_SCALE))
  );
}

/**
 * "Rp 85,000". Display only — never parsed back.
 *
 * Grouping comes from `formatDisplay`, the app's one number formatter, rather
 * than a second one written here.
 */
export function formatFiat(minor: bigint, code: string): string {
  const currency = findCurrency(code);
  if (!currency) return `${minor} ${code}`;
  return `${currency.prefix} ${formatDisplay(minor, currency.minorDigits, currency.minorDigits)}`;
}

export function quoteAgeSeconds(
  quote: FiatQuote,
  now: number = Math.floor(Date.now() / 1000)
): number {
  return now - quote.quotedAt;
}

/**
 * Whether this rate is too old to lock into a link.
 *
 * A quote from the future counts as stale too. It means a clock disagrees
 * somewhere, and "how old is this rate" has no answer worth acting on.
 */
export function isQuoteStale(
  quote: FiatQuote,
  now: number = Math.floor(Date.now() / 1000)
): boolean {
  const age = quoteAgeSeconds(quote, now);
  return age < 0 || age > MAX_QUOTE_AGE_SECONDS;
}
