/**
 * Turning one line of a bill into an ordinary payment request.
 *
 * This is the whole of the split-bill design in one function. A share is not a
 * new kind of obligation the payer page has to learn about — it is derived into
 * a complete v1 `PaymentRequest`, encoded by the codec that already exists, and
 * paid through a page that has no idea it was ever part of a bill.
 *
 * The alternative — an array of shares hanging off `PaymentRequest` itself, and
 * a payer page that understands portions — was rejected for putting the idea of
 * splitting inside the payment path, which today knows only how to owe one
 * amount to one recipient.
 */

import { encodeRequest } from "@/lib/request/codec";
import { MAX_MEMO_LENGTH, type PaymentRequest } from "@/lib/request/types";
import type { SplitBill } from "./types";

/**
 * The status key, and the request id, for one line of a bill.
 *
 * `-` rather than `.`, because `.` already means something: recurring
 * installments are stored under `<id>.<n>` (`installmentStatusId`). Two
 * different concepts sharing one separator is a way to save up a bug.
 *
 * `-` is inside the id character class `decodeRequest` accepts
 * (`/^[A-Za-z0-9_-]{1,32}$/`), and a 12-character bill id plus a suffix stays
 * comfortably under 32, so a derived id is a valid request id — and the status
 * route accepts it unchanged.
 */
export function shareStatusId(billId: string, index: number): string {
  return `${billId}-${index}`;
}

/**
 * Recover the bill and line a derived id came from, or `null`.
 *
 * base64url ids may themselves contain `-`, so the split is anchored on the
 * *last* one followed by digits alone. That keeps the parse unambiguous without
 * binding this function to how long `newRequestId` happens to make an id —
 * slicing at a fixed offset would work today and break silently the day that
 * length changes.
 */
export function parseShareId(
  id: string
): { billId: string; index: number } | null {
  const match = /^([A-Za-z0-9_-]+)-(\d{1,2})$/.exec(id);
  if (!match) return null;
  return { billId: match[1], index: Number(match[2]) };
}

/**
 * The memo the payer sees.
 *
 * Whose line this is comes first and is never dropped: if the two together run
 * past the memo limit, the note is what gets cut, because the name is the part
 * that tells the payer the link is meant for them.
 */
function shareMemo(label: string, memo?: string): string {
  const combined = memo ? `${label} — ${memo}` : label;
  return combined.length > MAX_MEMO_LENGTH
    ? combined.slice(0, MAX_MEMO_LENGTH)
    : combined;
}

export function shareToRequest(bill: SplitBill, index: number): PaymentRequest {
  const share = bill.shares[index];
  if (!share) {
    throw new RangeError(`This bill has no share ${index}.`);
  }

  return {
    id: shareStatusId(bill.id, index),
    recipient: bill.recipient,
    recipientName: bill.recipientName,
    token: bill.token,
    amount: share.amount,
    memo: shareMemo(share.label, share.memo),
    createdAt: bill.createdAt,
    expiresAt: bill.expiresAt,
  };
}

/** The payment link for one line — an ordinary `/pay/<payload>`. */
export function sharePath(bill: SplitBill, index: number): string {
  return `/pay/${encodeRequest(shareToRequest(bill, index))}`;
}
