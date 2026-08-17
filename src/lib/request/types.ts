/**
 * The payment request data model.
 *
 * A request is *self-describing*: everything a payer needs is carried in the
 * link itself, so `/pay/...` resolves with no database in the loop. That keeps
 * the demo dependency-free and means a link can't be broken by losing server
 * state.
 *
 * The one thing a link can't carry is what happened *after* it was created —
 * that lives in the optional status store (`@/lib/store`), keyed by `id`.
 */

import type { Schedule } from "./schedule";

export interface PaymentRequest {
  /** Random, unique per request. Also the key for the optional status store. */
  id: string;
  /**
   * Who gets paid. A Starknet address registered with the privacy pool.
   *
   * Always authoritative, even when `recipientName` is present: names can be
   * sold and re-pointed, addresses can't.
   */
  recipient: string;
  /**
   * Display label the request was created against (`alice.stark`), resolved to
   * `recipient` at creation time. Purely cosmetic — the payer page re-checks it
   * still points at `recipient` and says so if it doesn't.
   */
  recipientName?: string;
  /** Token contract address. */
  token: string;
  /**
   * Amount owed, in the token's smallest unit. Per installment when the
   * request recurs.
   */
  amount: bigint;
  /**
   * Present when the request repeats — a subscription or a standing invoice.
   *
   * The same link then asks for `amount` once per period, and the payer
   * approves each one; nothing about a schedule authorises a future charge.
   * See `./schedule`.
   */
  schedule?: Schedule;
  /** Optional note from the requester ("Invoice #42"). Shown to the payer. */
  memo?: string;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds. Absent means the link never expires. */
  expiresAt?: number;
}

/**
 * Lifecycle of a request, as far as Whisper Pay can honestly tell.
 *
 * There is a deliberate gap between `submitted` and `confirmed`. A private
 * transfer is relayed and carries no readable amount or parties, so the server
 * can verify that the payer's reported transaction exists, succeeded and
 * touched the pool — but *not* that it paid this request. Only the recipient,
 * seeing their own shielded balance, can close that gap. Hence two states.
 */
export type RequestStatus = "pending" | "submitted" | "confirmed" | "expired";

/**
 * What the server keeps about a request, and deliberately all of it.
 *
 * The payer's transaction hash is verified when it's reported and then thrown
 * away rather than stored. Keeping it would undo much of the point: for a payer
 * who had to shield first, the hash leads straight to a public deposit carrying
 * their address and the amount. Storing that against a request id would rebuild
 * the payer↔recipient link the pool exists to break — and hand it to anyone who
 * has the id, since status is readable by anyone who does.
 *
 * So the record is a lifecycle state and two timestamps. Nothing here
 * identifies a party, a token, or an amount.
 */
export interface StatusRecord {
  id: string;
  status: RequestStatus;
  /** Unix seconds. */
  submittedAt?: number;
  /** Unix seconds, set when the recipient confirms receipt. */
  confirmedAt?: number;
}

/** Longest memo we'll put in a link, to keep URLs manageable. */
export const MAX_MEMO_LENGTH = 140;

export function isExpired(
  request: Pick<PaymentRequest, "expiresAt">,
  now: number = Math.floor(Date.now() / 1000)
): boolean {
  return request.expiresAt !== undefined && now >= request.expiresAt;
}

/** Selectable link lifetimes, offered on the create form. */
export const EXPIRY_PRESETS = [
  { label: "1 hour", seconds: 60 * 60 },
  { label: "24 hours", seconds: 60 * 60 * 24 },
  { label: "7 days", seconds: 60 * 60 * 24 * 7 },
  { label: "30 days", seconds: 60 * 60 * 24 * 30 },
  { label: "Never", seconds: null },
] as const;
