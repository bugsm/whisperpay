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
  submitted: "bg-warn",
  confirmed: "bg-ok",
  expired: "bg-muted/40",
};

/**
 * A square, and lit by fill alone. The old dot carried a 12px blur halo, which
 * is the one effect a pixel grid can't render — and it sat next to a headline
 * stating the same thing in words, so nothing is lost by dropping it.
 */
export default function Dot({ status }: { status: RequestStatus }) {
  return <span aria-hidden className={`size-3 ${FILL[status]}`} />;
}
