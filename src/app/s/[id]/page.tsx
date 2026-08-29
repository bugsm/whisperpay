import type { Metadata } from "next";
import Link from "next/link";

import LiveStatus from "./LiveStatus";
import Badge from "@/components/ui/Badge";
import Card from "@/components/ui/Card";
import Dot from "@/components/ui/Dot";
import Row from "@/components/ui/Row";
import { CARD_SURFACE } from "@/components/ui/surfaces";
import { decodeSchedule } from "@/lib/request/codec";
import {
  currentInstallment,
  describePeriod,
  installmentDueAt,
  installmentStatusId,
} from "@/lib/request/schedule";
import type { RequestStatus, StatusRecord } from "@/lib/request/types";
import { getStatusStore } from "@/lib/store";

/**
 * The public status page.
 *
 * A payment link can't be shared to prove a payment happened — it carries the
 * whole invoice, so handing it to a third party hands them the amount, the
 * recipient and the note. This page exists to be shared instead: it's addressed
 * by the request id alone, which is 72 random bits and describes nothing.
 *
 * What a reader learns is exactly one fact per period — unpaid or received —
 * plus the date it changed. What they don't learn is the amount, the token,
 * either party, the note, or the transaction. The transaction particularly:
 * it's never stored (`StatusRecord`), because for a payer who shielded to pay,
 * the hash leads to a public deposit with their address on it.
 *
 * Dates are shown to the day and in UTC. An exact timestamp would narrow a
 * private transfer down to the handful of pool transactions in that second,
 * which is a strange thing to publish on a page whose whole point is that it
 * publishes almost nothing.
 */
export const metadata: Metadata = {
  title: "Payment status — Whisper Pay",
  description: "Whether a payment request has been settled. Nothing else.",
  robots: { index: false, follow: false },
};

/** Status is mutable, so a cached render would be a wrong render. */
export const dynamic = "force-dynamic";

/** Bare ids only — an installment is selected by the schedule, not the URL. */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** How many past periods a recurring page lists, newest first. */
const HISTORY_LIMIT = 12;

interface Period {
  index: number;
  number: number;
  dueAt: number;
  status: RequestStatus;
  /**
   * Whether a payer reported a transaction that was checked on-chain, as
   * opposed to the recipient marking this received by hand. `submittedAt` is
   * written only on the reporting path, so its absence is the difference —
   * and the page must not claim a verification that never happened.
   */
  reported: boolean;
}

export default async function StatusPage({
  params,
  searchParams,
}: PageProps<"/s/[id]">) {
  const { id } = await params;
  const { s } = await searchParams;

  if (!ID_PATTERN.test(id)) {
    return (
      <Card>
        <h1 className="text-lg font-semibold">This status link isn't valid</h1>
        <p className="mt-2 text-sm text-muted">
          It doesn't carry a readable request id.
        </p>
        <HomeLink />
      </Card>
    );
  }

  // A schedule parameter is optional, but a malformed one isn't ignorable: it
  // would silently turn a subscription's status page into a one-off's.
  const encodedSchedule = typeof s === "string" ? s : undefined;
  const schedule = encodedSchedule ? decodeSchedule(encodedSchedule) : null;
  if (encodedSchedule && !schedule) {
    return (
      <Card>
        <h1 className="text-lg font-semibold">This status link isn't valid</h1>
        <p className="mt-2 text-sm text-muted">
          Its schedule couldn't be read, so there's no telling which payment it
          means. Ask whoever shared it for a fresh link.
        </p>
        <HomeLink />
      </Card>
    );
  }

  const store = getStatusStore();
  const cycle = schedule ? currentInstallment(schedule) : null;

  // One read for a one-off; for a subscription, the current period and up to a
  // year of history behind it — bounded, so a long-running link can't turn one
  // page view into hundreds of store reads.
  const indices = cycle
    ? Array.from(
        { length: Math.min(cycle.index + 1, HISTORY_LIMIT) },
        (_, offset) => cycle.index - offset
      )
    : [0];

  let periods: Period[];
  try {
    periods = await Promise.all(
      indices.map(async (index) => {
        const key = schedule ? installmentStatusId(id, index) : id;
        const record: StatusRecord | null = await store.get(key);
        return {
          index,
          number: index + 1,
          dueAt: schedule ? installmentDueAt(schedule, index) : 0,
          status: record?.status ?? ("pending" satisfies RequestStatus),
          reported: record?.submittedAt !== undefined,
        };
      })
    );
  } catch {
    return (
      <Card>
        <h1 className="text-lg font-semibold">Status is unavailable</h1>
        <p className="mt-2 text-sm text-muted">
          The status store couldn't be reached. This says nothing about the
          payment itself — paying never goes through this server.
        </p>
        <HomeLink />
      </Card>
    );
  }

  const current = periods[0];
  const paidCount = periods.filter((p) => p.status === "confirmed").length;

  return (
    <div className="space-y-5">
      <Card>
        <p className="text-xs font-medium tracking-wide text-muted uppercase">
          Payment status
        </p>

        <div className="mt-3 flex items-center gap-3">
          <Dot status={current.status} />
          <h1 className="text-2xl font-semibold">{HEADLINE[current.status]}</h1>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-muted">
          {detailFor(current)}
        </p>

        {schedule && cycle ? (
          <dl className="mt-5 space-y-2 border-t border-hairline pt-4 text-sm">
            <Row label="Payment">
              {cycle.number}
              {cycle.total ? ` of ${cycle.total}` : ""}
            </Row>
            <Row label="Schedule">{describePeriod(schedule)}</Row>
            <Row label={cycle.notStarted ? "Starts" : "Due"}>
              {formatDate(cycle.dueAt)}
            </Row>
            {cycle.nextDueAt ? (
              <Row label="Next payment">
                <span className="text-muted">{formatDate(cycle.nextDueAt)}</span>
              </Row>
            ) : null}
          </dl>
        ) : null}

        <LiveStatus settled={current.status === "confirmed"} />

        {!store.durable ? (
          <p className="mt-5 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-200/80">
            This deployment has no status store configured, so nothing is being
            persisted — treat anything above as incomplete rather than as a
            record.
          </p>
        ) : null}
      </Card>

      {schedule && periods.length > 1 ? (
        <section className={CARD_SURFACE}>
          <h2 className="text-sm font-semibold">Recent periods</h2>
          <p className="mt-1 text-xs text-muted">
            {paidCount} of the last {periods.length} confirmed received.
          </p>
          <ul className="mt-4 divide-y divide-hairline">
            {periods.map((period) => (
              <li
                key={period.index}
                className="flex items-center gap-3 py-2.5 text-sm"
              >
                <span className="text-muted">Payment {period.number}</span>
                <span className="ml-auto text-xs text-muted">
                  {formatDate(period.dueAt)}
                </span>
                <Badge status={period.status} subtle />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={CARD_SURFACE}>
        <h2 className="text-sm font-semibold">What this page shows</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Whether a request has been settled, and when — to the day, in UTC. It
          carries no amount, no token, neither party's address, no note and no
          transaction hash, because none of those are stored against a request
          id in the first place. Sharing this link discloses that a payment
          happened, not what it was.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          <strong className="font-medium text-foreground">
            What "received" is worth here:
          </strong>{" "}
          {current.status === "confirmed" && !current.reported ? (
            <>
              nothing was reported for this one and nothing was checked against
              the chain — the recipient marked it received themselves. That is
              their word, and their shielded balance is the only place it could
              have come from, which nobody else can see.
            </>
          ) : (
            <>
              the reported transaction is checked against the chain — it
              exists, it succeeded, it touched the pool. It cannot be checked
              against <em>this</em> request, because a private transfer hides
              its amount and its parties. So this page reports a verified
              payment, not a proven one; a recipient who needs certainty has
              their own shielded balance, which nobody else can see.
            </>
          )}
        </p>
        <Link
          href="/"
          className="mt-4 inline-block rounded-xl border border-hairline px-4 py-2 text-sm transition hover:bg-surface-raised"
        >
          What is Whisper Pay?
        </Link>
      </section>
    </div>
  );
}

const HEADLINE: Record<RequestStatus, string> = {
  pending: "Awaiting payment",
  submitted: "Payment submitted",
  confirmed: "Received",
  expired: "Expired",
};

const DETAIL: Record<RequestStatus, string> = {
  pending: "Nothing has been reported against this request yet.",
  // Retired: kept so records written before payments settled themselves still
  // render something true.
  submitted:
    "A payer reported a transaction for this request, verified against the chain.",
  confirmed:
    "A payer reported a transaction for this request, and it checks out on-chain: it exists, it succeeded, and it went through the privacy pool. What it can't show anyone is the amount or the parties — that's the pool working.",
  expired: "This request is no longer payable.",
};

/**
 * A request can reach `confirmed` two ways, and they are worth very
 * different amounts to whoever reads this page. One was checked against the
 * chain; the other is the recipient's own word, with nothing behind it. The
 * page used to describe every confirmation as the first kind.
 */
function detailFor(period: Period): string {
  if (period.status === "confirmed" && !period.reported) {
    return (
      "The recipient marked this received themselves. No transaction was " +
      "reported to this server and nothing was checked on-chain — this is " +
      "their word that the money arrived, which is the only thing anyone " +
      "reading a private payment can offer."
    );
  }
  return DETAIL[period.status];
}

/** Dates render on the server, so they're pinned to UTC to stay deterministic. */
function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function HomeLink() {
  return (
    <Link
      href="/"
      className="mt-5 inline-block rounded-xl border border-hairline px-4 py-2 text-sm transition hover:bg-surface-raised"
    >
      What is Whisper Pay?
    </Link>
  );
}
