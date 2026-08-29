import type { RequestStatus } from "@/lib/request/types";

/**
 * What each lifecycle state is called in the interface.
 *
 * "Received" rather than "Paid" for `confirmed` is deliberate and load-bearing:
 * a verified pool transaction proves *a* successful transfer, not that this
 * request was settled. See the doc comment on `RequestStatus`.
 */
export const STATUS_LABEL: Record<RequestStatus, string> = {
  pending: "Unpaid",
  submitted: "Submitted",
  confirmed: "Received",
  expired: "Expired",
};

/** Tinted border and text — the default, used where the reader owns the request. */
const TINTED: Record<RequestStatus, string> = {
  pending: "border-hairline text-muted",
  submitted: "border-warn text-warn",
  confirmed: "border-ok text-ok",
  expired: "border-hairline text-muted line-through",
};

/** Text tone only, on a plain hairline border. */
const SUBTLE: Record<RequestStatus, string> = {
  pending: "border-hairline text-muted",
  submitted: "border-hairline text-warn",
  confirmed: "border-hairline text-ok",
  expired: "border-hairline text-muted",
};

/**
 * A status pill.
 *
 * `subtle` exists for the public status page, which is shared with people who
 * are not owed anything and shouldn't be shown a page that reads as an alert.
 * That page states the fact and stops; the dashboard, where the reader is the
 * one waiting to be paid, earns the louder treatment.
 */
export default function Badge({
  status,
  subtle = false,
}: {
  status: RequestStatus;
  subtle?: boolean;
}) {
  return (
    <span
      className={`display shrink-0 border-2 px-2 py-0.5 text-xs ${
        (subtle ? SUBTLE : TINTED)[status]
      }`}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
