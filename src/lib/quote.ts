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
   * Digits in the currency's minor unit — ISO 4217's exponent.
   *
   * This is the highest-consequence number in the file. Every amount on a
   * receipt is carried in minor units, so an entry that says 2 where the truth
   * is 0 asks each person for a hundred times what they ate.
   */
  minorDigits: number;
  /** What goes in front of the number. */
  prefix: string;
}

/**
 * Currencies a receipt may be denominated in.
 *
 * Two things bound this list, and neither is arbitrary. The price source only
 * quotes STRK against a fixed set of fiat, so a currency it doesn't quote can't
 * be converted no matter how well the photo was read. And every entry needs its
 * exponent right, which is a fact to be looked up rather than derived — so the
 * table is written out, not generated from a locale API that would answer for
 * currencies the rate source has never heard of.
 *
 * Grouped by exponent rather than alphabetically. Two decimals is the case
 * nobody needs to check; the other two groups are where a mistake hides, and
 * putting them under their own headings is what makes them reviewable.
 */
const TABLE: readonly (readonly [code: string, minorDigits: number, prefix: string])[] = [
  // No minor unit. Prices are whole units and receipts never show a decimal.
  //
  // Rupiah is the deliberate deviation: ISO still gives it 2 for the sen, but
  // the sen has not been legal tender in living memory and no Indonesian
  // receipt prints one. Following ISO here would inflate every Indonesian bill
  // by a hundred — the standard is wrong about the thing this feature was
  // actually built for.
  ["IDR", 0, "Rp"],
  ["JPY", 0, "¥"],
  ["KRW", 0, "₩"],
  ["VND", 0, "₫"],
  ["CLP", 0, "CLP$"],

  // Three, which the Gulf dinars genuinely use and print.
  ["BHD", 3, "BHD"],
  ["KWD", 3, "KWD"],

  // Two — everything else.
  ["AED", 2, "AED"],
  ["ARS", 2, "ARS$"],
  ["AUD", 2, "A$"],
  ["BDT", 2, "৳"],
  ["BRL", 2, "R$"],
  ["CAD", 2, "C$"],
  ["CHF", 2, "CHF"],
  ["CNY", 2, "CN¥"],
  ["CZK", 2, "Kč"],
  ["DKK", 2, "kr"],
  ["EUR", 2, "€"],
  ["GBP", 2, "£"],
  ["GEL", 2, "₾"],
  ["HKD", 2, "HK$"],
  ["HUF", 2, "Ft"],
  ["ILS", 2, "₪"],
  ["INR", 2, "₹"],
  ["LKR", 2, "Rs"],
  ["MMK", 2, "K"],
  ["MXN", 2, "MX$"],
  ["MYR", 2, "RM"],
  ["NGN", 2, "₦"],
  ["NOK", 2, "kr"],
  ["NZD", 2, "NZ$"],
  ["PHP", 2, "₱"],
  ["PKR", 2, "₨"],
  ["PLN", 2, "zł"],
  ["RUB", 2, "₽"],
  ["SAR", 2, "SAR"],
  ["SEK", 2, "kr"],
  ["SGD", 2, "S$"],
  ["THB", 2, "฿"],
  ["TRY", 2, "₺"],
  ["TWD", 2, "NT$"],
  ["UAH", 2, "₴"],
  ["USD", 2, "$"],
  ["ZAR", 2, "R"],
];

export const CURRENCIES: Record<string, Currency> = Object.fromEntries(
  TABLE.map(([code, minorDigits, prefix]) => [
    code,
    { code, minorDigits, prefix },
  ])
);

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
 * "Rp 85,000", "$ 12.50", "BHD 12.500". Display only — never parsed back.
 *
 * Grouping still comes from `formatDisplay`, the app's one number formatter,
 * but only for the whole part. Money is written to a fixed width and a token
 * amount is not: `formatDisplay` strips trailing zeros, which is right for
 * 12.5 STRK and wrong for a receipt, where the same rule prints "$ 12.5" and
 * "€ 8" for amounts that were printed "$12.50" and "€8.00". So the fraction is
 * padded back out to the currency's own width here.
 *
 * That only ever showed once a currency with a minor unit could reach this —
 * the table was rupiah and USD, and rupiah has no fraction to strip.
 */
export function formatFiat(minor: bigint, code: string): string {
  const currency = findCurrency(code);
  if (!currency) return `${minor} ${code}`;

  // The sign goes in front of the symbol, which is where a reader expects it.
  // Negatives reach here: a discount larger than the lines it is taken from.
  const negative = minor < 0n;
  const magnitude = negative ? -minor : minor;
  const scale = 10n ** BigInt(currency.minorDigits);

  const whole = formatDisplay(magnitude / scale, 0);
  const fraction =
    currency.minorDigits === 0
      ? ""
      : `.${(magnitude % scale).toString().padStart(currency.minorDigits, "0")}`;

  return `${negative ? "-" : ""}${currency.prefix} ${whole}${fraction}`;
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
