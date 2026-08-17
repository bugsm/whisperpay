import type { Metadata } from "next";
import Link from "next/link";

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
 * What a reader learns is exactly one fact per period — unpaid, submitted, or
 * received — plus the date it changed. What they don't learn is the amount, the
 * token, either party, the note, or the transaction. The transaction
 * particularly: it's never stored (`StatusRecord`), because for a payer who
 * shielded to pay, the hash leads to a public deposit with their address on it.
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
}

export default async function StatusPage({
  params,
  searchParams,
}: PageProps<"/s/[id]">) {
  const { id } = await params;
  const { s } = await searchParams;

  if (!ID_PATTERN.test(id)) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">This status link isn't valid</h1>
        <p className="mt-2 text-sm text-muted">
          It doesn't carry a readable request id.
        </p>
        <HomeLink />
      </Shell>
    );
  }

  // A schedule parameter is optional, but a malformed one isn't ignorable: it
  // would silently turn a subscription's status page into a one-off's.
  const encodedSchedule = typeof s === "string" ? s : undefined;
  const schedule = encodedSchedule ? decodeSchedule(encodedSchedule) : null;
  if (encodedSchedule && !schedule) {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">This status link isn't valid</h1>
        <p className="mt-2 text-sm text-muted">
          Its schedule couldn't be read, so there's no telling which payment it
          means. Ask whoever shared it for a fresh link.
        </p>
        <HomeLink />
      </Shell>
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
        };
      })
    );
  } catch {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">Status is unavailable</h1>
        <p className="mt-2 text-sm text-muted">
          The status store couldn't be reached. This says nothing about the
          payment itself — paying never goes through this server.
        </p>
        <HomeLink />
      </Shell>
    );
  }

  const current = periods[0];
  const paidCount = periods.filter((p) => p.status === "confirmed").length;

  return (
    <div className="space-y-5">
      <Shell>
        <p className="text-xs font-medium tracking-wide text-muted uppercase">
          Payment status
        </p>

        <div className="mt-3 flex items-center gap-3">
          <Dot status={current.status} />
          <h1 className="text-2xl font-semibold">{HEADLINE[current.status]}</h1>
        </div>

        <p className="mt-3 text-sm leading-relaxed text-muted">
          {DETAIL[current.status]}
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

        {!store.durable ? (
          <p className="mt-5 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-200/80">
            This deployment has no status store configured, so nothing is being
            persisted — treat anything above as incomplete rather than as a
            record.
          </p>
        ) : null}
      </Shell>

      {schedule && periods.length > 1 ? (
        <section className="rounded-2xl border border-hairline bg-surface p-6">
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
                <Badge status={period.status} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="rounded-2xl border border-hairline bg-surface p-6">
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
            Why "submitted" isn't "received":
          </strong>{" "}
          a private transfer hides its amount and its parties, so a reported
          transaction can be verified as a real pool transaction but never as
          payment of this request. Only the recipient, reading their own shielded
          balance, can say the money arrived.
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
  submitted:
    "A payer reported a verified pool transaction. The recipient hasn't confirmed the money landed yet.",
  confirmed:
    "The recipient confirmed this arrived in their shielded balance. That's the strongest confirmation there is — nobody else can see it.",
  expired: "This request is no longer payable.",
};

const TONE: Record<RequestStatus, string> = {
  pending: "text-muted",
  submitted: "text-amber-300",
  confirmed: "text-emerald-300",
  expired: "text-muted",
};

/** Dates render on the server, so they're pinned to UTC to stay deterministic. */
function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-GB", {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function Dot({ status }: { status: RequestStatus }) {
  const fill: Record<RequestStatus, string> = {
    pending: "bg-muted/40",
    submitted: "bg-amber-400 shadow-[0_0_12px] shadow-amber-400/60",
    confirmed: "bg-emerald-400 shadow-[0_0_12px] shadow-emerald-400/60",
    expired: "bg-muted/40",
  };
  return <span aria-hidden className={`size-3 rounded-full ${fill[status]}`} />;
}

function Badge({ status }: { status: RequestStatus }) {
  const label: Record<RequestStatus, string> = {
    pending: "Unpaid",
    submitted: "Submitted",
    confirmed: "Received",
    expired: "Expired",
  };
  return (
    <span
      className={`shrink-0 rounded-full border border-hairline px-2.5 py-0.5 text-xs ${TONE[status]}`}
    >
      {label[status]}
    </span>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-6">
      {children}
    </section>
  );
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
