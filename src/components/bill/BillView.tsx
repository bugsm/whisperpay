"use client";

import Card from "@/components/ui/Card";
import Notice from "@/components/ui/Notice";
import Row from "@/components/ui/Row";
import { CARD_SURFACE } from "@/components/ui/surfaces";
import type { FiatQuote } from "@/lib/bill/types";
import { formatFiat, tokenUnitsToFiat } from "@/lib/quote";
import { DEFAULT_TOKEN } from "@/lib/strk20/constants";
import BillRows, { type BillRowDto } from "./BillRows";

/**
 * The organiser's view of a bill, wherever the bill came from.
 *
 * Two routes render this and they arrive by opposite paths: `/bill/<payload>`
 * decodes on the server and reads status there, while `/b/<id>#<key>` decrypts
 * in the browser and polls for status itself. Everything after that point is
 * identical, so it lives here once — a short link that showed a subtly
 * different page from the link it shortens would be its own bug.
 *
 * A client component because `BillRows` is one: copying, QR codes and the
 * clipboard all belong to the browser.
 */
export interface BillViewProps {
  title?: string;
  /** `.stark` name if there was one, otherwise the address. */
  recipientLabel: string;
  symbol: string;
  /** Already formatted — the caller owns the token's decimals. */
  total: string;
  rows: BillRowDto[];
  expiresAt?: number;
  expired: boolean;
  /** False when no status store is configured: the badges mean nothing then. */
  durable: boolean;
  /**
   * The rate this bill was priced against, when it came from a receipt.
   *
   * Shown beside the total as context and nowhere near a decision. The links
   * ask for the STRK figure and always will — see `@/lib/quote`.
   */
  quote?: FiatQuote;
  /** The total in the token's smallest unit, for converting back for display. */
  totalUnits?: string;
  /**
   * Which kind of link the reader is holding. It changes exactly one paragraph
   * — the one about what happens if they lose it — and that paragraph is the
   * honest difference between the two.
   */
  variant: "stateless" | "short";
  /** The page's own live-refresh element, which differs between the two routes. */
  children?: React.ReactNode;
}

export default function BillView({
  title,
  recipientLabel,
  symbol,
  total,
  rows,
  expiresAt,
  expired,
  durable,
  quote,
  totalUnits,
  variant,
  children,
}: BillViewProps) {
  const paid = rows.filter((row) => row.status === "confirmed").length;

  return (
    <div className="space-y-5">
      <Card>
        <p className="display text-xs tracking-wide text-muted uppercase">
          Split bill
        </p>
        <h1 className="display mt-2 text-2xl">{title ?? "Shared bill"}</h1>

        <dl className="mt-5 space-y-2 border-t-2 border-hairline pt-4 text-sm">
          <Row label="Total">
            <span className="tabular text-lg">
              {total} <span className="text-sm text-muted">{symbol}</span>
            </span>
          </Row>
          {quote && totalUnits ? (
            <Row label="On the receipt">
              <span className="tabular text-muted">
                ≈{" "}
                {formatFiat(
                  tokenUnitsToFiat(BigInt(totalUnits), quote, DEFAULT_TOKEN.decimals),
                  quote.currency
                )}
              </span>
            </Row>
          ) : null}
          <Row label="Paid">
            <span className="tabular">
              {paid} of {rows.length}
            </span>
          </Row>
          <Row label="Paid to">
            <span className="font-mono text-xs break-all">{recipientLabel}</span>
          </Row>
          {expiresAt !== undefined ? (
            <Row label={expired ? "Expired" : "Links expire"}>
              {formatDate(expiresAt)}
            </Row>
          ) : null}
        </dl>

        <BillRows rows={rows} title={title} symbol={symbol} total={total} />

        {quote ? (
          <p className="mt-4 text-xs leading-relaxed text-muted">
            This bill was priced from a receipt at the rate on{" "}
            {new Date(quote.quotedAt * 1000).toLocaleDateString("en-GB", {
              timeZone: "UTC",
              day: "numeric",
              month: "short",
            })}
            .{" "}
            <strong className="font-medium text-foreground">
              What each link asks for is {symbol}
            </strong>{" "}
            — that figure is fixed, and the {quote.currency} beside it is
            context that doesn't follow the market.
          </p>
        ) : null}

        {children}

        {expired ? (
          <div className="mt-5">
            <Notice tone="warn" title="These links have expired">
              A payer opening one now is told it's no longer payable. Build the
              bill again if it still needs settling — nothing was stored, so
              there is nothing to reopen.
            </Notice>
          </div>
        ) : null}

        {!durable ? (
          <div className="mt-5">
            <Notice tone="warn" title="No status store on this deployment">
              Every link above works — they don't need a server. What can't be
              tracked is who has paid, so treat the badges as unknown rather
              than as a record.
            </Notice>
          </div>
        ) : null}
      </Card>

      <section className={CARD_SURFACE}>
        <h2 className="display text-sm">What this page is</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          A bill isn't a new kind of payment. Each line above is an ordinary
          Whisper Pay request with its own link, so whoever you send one to sees
          a normal payment page and pays through the pool exactly as they would
          for a single request. Nothing about the group is visible to them, or
          to anyone else.
        </p>
        {variant === "stateless" ? (
          <p className="mt-3 text-sm leading-relaxed text-muted">
            The whole bill lives in this URL. Nothing here was written to a
            database, which also means this page can't be recovered if the link
            is lost — keep it, it's the only copy. What opening it does do, like
            opening any URL, is hand the address to whoever hosts this app.
          </p>
        ) : (
          <p className="mt-3 text-sm leading-relaxed text-muted">
            This is the short version of the link. The bill was encrypted in
            your browser before it was stored, and the key is the part of the
            URL after the <code className="font-mono">#</code> — which browsers
            never send to a server. So the server is holding bytes it can't
            read, and anyone who has this whole link can read them. The catch is
            the one above: unlike the full link, this one expires.
          </p>
        )}
      </section>
    </div>
  );
}

/** Pinned to UTC so a server render and a client render agree. */
function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}
