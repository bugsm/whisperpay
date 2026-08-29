import type { RequestStatus } from "@/lib/request/types";

/**
 * What badge a line wears, given what the store said and whether the bill has
 * expired.
 *
 * Shared by both routes deliberately. They arrive at a status differently —
 * the server page reads the store and gets `null` for an untouched line, while
 * the short-link page reads the API, which fills a missing record in as
 * `pending` — and left to themselves they disagreed about expired bills: one
 * showed "Expired", the other "Unpaid", for the same bill. Deriving it in one
 * place is what stops the two views of one bill from contradicting each other.
 *
 * `confirmed` outranks expiry: money that arrived before the deadline arrived.
 */
export function rowStatus(
  stored: RequestStatus | null | undefined,
  expired: boolean
): RequestStatus {
  if (stored && stored !== "pending") return stored;
  return expired ? "expired" : (stored ?? "pending");
}
