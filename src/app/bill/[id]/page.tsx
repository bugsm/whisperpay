import type { Metadata } from "next";
import Link from "next/link";

import LiveStatus from "@/app/s/[id]/LiveStatus";
import type { BillRowDto } from "@/components/bill/BillRows";
import BillView from "@/components/bill/BillView";
import { buttonClass } from "@/components/ui/Button";
import Card from "@/components/ui/Card";
import { formatDisplay } from "@/lib/amount";
import { BillDecodeError, decodeBill } from "@/lib/bill/codec";
import { sharePath, shareStatusId } from "@/lib/bill/share";
import { rowStatus } from "@/lib/bill/status";
import { billTotal } from "@/lib/bill/types";
import { isExpired, type StatusRecord } from "@/lib/request/types";
import { getStatusStore } from "@/lib/store";
import { DEFAULT_TOKEN, findToken } from "@/lib/strk20/constants";

/**
 * Link previews stay generic here for the same reason they do on `/pay`: chat
 * apps fetch and cache what they find, and this payload carries everyone's name
 * and everyone's share.
 */
export const metadata: Metadata = {
  title: "Split bill — Whisper Pay",
  description: "One link per person, and who has paid so far.",
  robots: { index: false, follow: false },
};

/** Status moves while this page is open, so a cached render would be a wrong one. */
export const dynamic = "force-dynamic";

/**
 * The organiser's view of a split bill.
 *
 * The payload is the address, exactly as on `/pay` — there is no lookup and no
 * row in a database, so this page works whether or not a status store exists.
 * What the store adds is the one thing a link cannot carry: which lines have
 * been paid.
 *
 * The rendering itself is `BillView`, shared with `/b/<id>` so the short link
 * cannot drift into showing something subtly different.
 */
export default async function BillPage({ params }: PageProps<"/bill/[id]">) {
  const { id } = await params;

  let bill;
  try {
    bill = decodeBill(id);
  } catch (error) {
    return (
      <Card>
        <h1 className="display text-lg">This bill link isn't valid</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {error instanceof BillDecodeError
            ? error.message
            : "The link couldn't be read."}{" "}
          A bill link carries every line in the URL, so it's long — and some chat
          apps cut long links in half.
        </p>
        <Link href="/bill" className={`${buttonClass()} mt-5`}>
          Build a new bill
        </Link>
      </Card>
    );
  }

  const token = findToken(bill.token) ?? DEFAULT_TOKEN;
  const total = billTotal(bill.shares);
  const expired = isExpired(bill);

  const store = getStatusStore();
  let records: (StatusRecord | null)[];
  try {
    records = await store.getMany(
      bill.shares.map((_, index) => shareStatusId(bill.id, index))
    );
  } catch {
    // One unreachable store is not a reason to hide everyone's links — the
    // links are in this page's own URL and work without any server at all.
    records = bill.shares.map(() => null);
  }

  const rows: BillRowDto[] = bill.shares.map((share, index) => ({
    label: share.label,
    memo: share.memo,
    amount: formatDisplay(share.amount, token.decimals),
    path: sharePath(bill, index),
    status: rowStatus(records[index]?.status, expired),
  }));

  const settled = rows.every((row) => row.status === "confirmed");

  return (
    <BillView
      title={bill.title}
      recipientLabel={bill.recipientName ?? bill.recipient}
      symbol={token.symbol}
      total={formatDisplay(total, token.decimals)}
      rows={rows}
      expiresAt={bill.expiresAt}
      expired={expired}
      durable={store.durable}
      quote={bill.quote}
      totalUnits={total.toString()}
      variant="stateless"
    >
      {/* This page is server-rendered, so refreshing it re-reads the store. */}
      <LiveStatus settled={settled} />
    </BillView>
  );
}
