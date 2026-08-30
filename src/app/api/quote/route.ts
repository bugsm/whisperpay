import type { NextRequest } from "next/server";

import type { FiatQuote } from "@/lib/bill/types";
import { DEFAULT_CURRENCY, findCurrency, RATE_SCALE } from "@/lib/quote";

/**
 * What one STRK is worth, for putting a receipt's own money into a bill.
 *
 * Display context, and only that. The number a link asks for is always STRK —
 * see `@/lib/quote` for why that is a design decision rather than a shortcut.
 * If this endpoint is down, a bill can still be built; it just loses the
 * "≈ Rp 85,000" beside each amount.
 *
 * A price is nobody's personal data, so caching it in a shared cache breaks no
 * promise this app makes. Sixty seconds is short enough that a locked-in rate
 * is never far from the market and long enough that a busy page doesn't hammer
 * a public API.
 *
 * GET /api/quote?currency=IDR → { quote: { currency, rate, quotedAt } }
 *
 * Considered and rejected: an on-chain oracle. It would put an RPC call in the
 * link-creation path — which today touches the network only to resolve a
 * `.stark` name — and the ones available quote USD pairs, while the receipts
 * this exists for are written in whatever the till printed.
 */

/**
 * One currency per call, named by the caller.
 *
 * The pair used to be baked in, which quietly made "any currency" mean "these
 * two". `currency.code` comes from the table in `@/lib/quote` and never from
 * the query string, so nothing user-supplied reaches this URL.
 */
function source(code: string): string {
  return `https://api.coingecko.com/api/v3/simple/price?ids=starknet&vs_currencies=${code.toLowerCase()}`;
}

/** The upstream call is cached; so is this route's own response. */
export const revalidate = 60;

export async function GET(request: NextRequest) {
  const requested = request.nextUrl.searchParams.get("currency");
  const currency = requested
    ? findCurrency(requested)
    : DEFAULT_CURRENCY;

  if (!currency) {
    return Response.json(
      { error: `Whisper Pay has no rate for ${requested}.` },
      { status: 400 }
    );
  }

  let body: Record<string, Record<string, number>>;
  try {
    const response = await fetch(source(currency.code), { next: { revalidate } });
    if (!response.ok) {
      throw new Error(`price source answered ${response.status}`);
    }
    body = await response.json();
  } catch {
    return Response.json(
      {
        error:
          "Couldn't reach the price source. You can still build the bill — it just won't carry the receipt's own figures.",
      },
      { status: 503 }
    );
  }

  const price = body?.starknet?.[currency.code.toLowerCase()];
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    // A currency in this app's table that the source doesn't quote comes back
    // as a missing key rather than an error, so it lands here. Said plainly:
    // the bill is still buildable, just not from the receipt's own numbers.
    return Response.json(
      {
        error: `The price source doesn't quote STRK in ${currency.code} right now. You can still enter each share in STRK by hand.`,
      },
      { status: 502 }
    );
  }

  // The one `number` in any money path in this codebase, and it is unavoidable:
  // the price arrives as a JSON number. It becomes a decimal string here and
  // immediately, and every calculation downstream is `bigint` — so the float
  // exists for one multiplication, eight decimal places wide, on a figure whose
  // job is to sit next to an amount rather than to be one.
  const rate = (price * 10 ** currency.minorDigits).toFixed(RATE_SCALE);

  const quote: FiatQuote = {
    currency: currency.code,
    rate,
    quotedAt: Math.floor(Date.now() / 1000),
  };

  return Response.json({ quote });
}
