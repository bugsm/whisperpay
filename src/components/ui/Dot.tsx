import type { RequestStatus } from "@/lib/request/types";

/**
 * A status light.
 *
 * Purely decorative — `aria-hidden`, because every place it appears already
 * carries the same state as text. Colour is never the only signal, which is
 * also why the two resting states (`pending`, `expired`) look alike here: the
 * difference between them is a word, and the word is next to it.
 */
const FILL: Record<RequestStatus, string> = {
  pending: "bg-muted/40",
  submitted: "bg-amber-400 shadow-[0_0_12px] shadow-amber-400/60",
  confirmed: "bg-emerald-400 shadow-[0_0_12px] shadow-emerald-400/60",
  expired: "bg-muted/40",
};

export default function Dot({ status }: { status: RequestStatus }) {
  return <span aria-hidden className={`size-3 rounded-full ${FILL[status]}`} />;
}
