/**
 * Encoding a payment request into a link, and back.
 *
 * The wire format is a compact JSON object, base64url-encoded, sitting in the
 * URL path. It is *not* signed: anyone can mint a link, which is the point —
 * there's no account system. Tampering with someone else's link only produces a
 * different request, and the payer sees the recipient and amount before they
 * approve anything in their wallet.
 *
 * Because the payload is entirely attacker-controlled, `decodeRequest`
 * validates every field and refuses anything it doesn't fully understand.
 */

import { isStarkDomain } from "@/lib/identity/encoding";
import { isValidAddress, findToken, normalizeAddress } from "@/lib/strk20/constants";
import { isValidSchedule, type PeriodUnit, type Schedule } from "./schedule";
import { MAX_MEMO_LENGTH, type PaymentRequest } from "./types";

export class RequestDecodeError extends Error {}

/** Compact wire shape. Short keys keep links short. */
interface Wire {
  /** 1 for a one-off request, 2 when a schedule is attached. */
  v: 1 | 2;
  i: string;
  r: string;
  t: string;
  /** Decimal string, smallest unit — JSON has no bigint. */
  a: string;
  m?: string;
  c: number;
  e?: number;
  /** Optional `.stark` display label. Added after v1 shipped; older links omit it. */
  n?: string;
  /** Recurrence. Only ever present on v2. */
  s?: WireSchedule;
}

/** `{unit, every, count, anchor}`, one letter each. */
interface WireSchedule {
  u: "d" | "w" | "m";
  e: number;
  /** Omitted for an open-ended schedule. */
  c?: number;
  a: number;
}

const UNIT_TO_WIRE: Record<PeriodUnit, WireSchedule["u"]> = {
  day: "d",
  week: "w",
  month: "m",
};

const WIRE_TO_UNIT: Record<string, PeriodUnit> = {
  d: "day",
  w: "week",
  m: "month",
};

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new RequestDecodeError("Link contains characters that aren't valid.");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new RequestDecodeError("Link isn't valid base64.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 12-character URL-safe id, ~72 bits of randomness. */
export function newRequestId(): string {
  const bytes = new Uint8Array(9);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function encodeRequest(request: PaymentRequest): string {
  // A recurring link is v2 so that a build predating M4 refuses it outright
  // rather than quietly reading it as a single payment for one installment.
  const wire: Wire = {
    v: request.schedule ? 2 : 1,
    i: request.id,
    r: request.recipient,
    t: request.token,
    a: request.amount.toString(),
    c: request.createdAt,
  };
  if (request.memo) wire.m = request.memo;
  if (request.expiresAt !== undefined) wire.e = request.expiresAt;
  if (request.recipientName) wire.n = request.recipientName;
  if (request.schedule) {
    wire.s = {
      u: UNIT_TO_WIRE[request.schedule.unit],
      e: request.schedule.every,
      a: request.schedule.anchor,
    };
    if (request.schedule.count !== null) wire.s.c = request.schedule.count;
  }

  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(wire)));
}

/**
 * The path of a request's **public status page**.
 *
 * Addressed by id alone, because the id is the one part of a request that
 * describes nothing about it — 72 random bits, no amount, no addresses, no
 * memo. That's what makes the page shareable with someone who shouldn't see the
 * invoice itself.
 *
 * A recurring request needs its schedule too, or the page could only ever
 * describe a single period. The `s` parameter carries cadence and length and
 * nothing else, so the page gains "payment 3 of 12" without gaining anything
 * about who or how much.
 */
export function statusPath(id: string, schedule?: Schedule): string {
  return schedule
    ? `/s/${id}?s=${encodeSchedule(schedule)}`
    : `/s/${id}`;
}

export function encodeSchedule(schedule: Schedule): string {
  const wire: WireSchedule = {
    u: UNIT_TO_WIRE[schedule.unit],
    e: schedule.every,
    a: schedule.anchor,
  };
  if (schedule.count !== null) wire.c = schedule.count;
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(wire)));
}

/** `null` for anything malformed — the status page says so rather than guessing. */
export function decodeSchedule(encoded: string): Schedule | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const wire = parsed as Partial<WireSchedule>;
  const candidate = {
    unit: WIRE_TO_UNIT[wire.u as string],
    every: wire.e,
    count: wire.c ?? null,
    anchor: wire.a,
  };
  return isValidSchedule(candidate) ? candidate : null;
}

export function decodeRequest(encoded: string): PaymentRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch (error) {
    if (error instanceof RequestDecodeError) throw error;
    throw new RequestDecodeError("Link payload isn't readable.");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new RequestDecodeError("Link payload isn't an object.");
  }
  const wire = parsed as Partial<Wire>;

  if (wire.v !== 1 && wire.v !== 2) {
    throw new RequestDecodeError(
      "This link was made by a newer version of Whisper Pay."
    );
  }
  // A schedule on a v1 payload would be read as a one-off by anything older,
  // which is exactly the mistake the version bump exists to prevent.
  if (wire.v === 1 && wire.s !== undefined) {
    throw new RequestDecodeError("Link's version doesn't match its contents.");
  }

  if (typeof wire.i !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(wire.i)) {
    throw new RequestDecodeError("Link is missing a valid request id.");
  }

  if (typeof wire.r !== "string" || !isValidAddress(wire.r)) {
    throw new RequestDecodeError("Link doesn't carry a valid recipient address.");
  }

  if (typeof wire.t !== "string" || !isValidAddress(wire.t)) {
    throw new RequestDecodeError("Link doesn't carry a valid token address.");
  }
  if (!findToken(wire.t)) {
    throw new RequestDecodeError(
      "This link asks for a token Whisper Pay doesn't support."
    );
  }

  if (typeof wire.a !== "string" || !/^\d+$/.test(wire.a)) {
    throw new RequestDecodeError("Link doesn't carry a valid amount.");
  }
  const amount = BigInt(wire.a);
  if (amount <= 0n) {
    throw new RequestDecodeError("Payment amount must be greater than zero.");
  }

  if (typeof wire.c !== "number" || !Number.isFinite(wire.c) || wire.c <= 0) {
    throw new RequestDecodeError("Link doesn't carry a valid creation time.");
  }

  if (
    wire.e !== undefined &&
    (typeof wire.e !== "number" || !Number.isFinite(wire.e) || wire.e <= 0)
  ) {
    throw new RequestDecodeError("Link carries an invalid expiry.");
  }

  if (wire.m !== undefined) {
    if (typeof wire.m !== "string") {
      throw new RequestDecodeError("Link carries an invalid memo.");
    }
    if (wire.m.length > MAX_MEMO_LENGTH) {
      throw new RequestDecodeError("Link's memo is too long.");
    }
  }

  // A malformed label would be shown next to a real address, so hold it to the
  // same standard as everything else rather than rendering whatever arrives.
  if (wire.n !== undefined) {
    if (typeof wire.n !== "string" || !isStarkDomain(wire.n.toLowerCase())) {
      throw new RequestDecodeError("Link carries an invalid recipient name.");
    }
  }

  // The schedule drives what the payer is asked for and when, so it gets the
  // same treatment as the amount: fully validated, or the link is refused.
  let schedule: Schedule | undefined;
  if (wire.s !== undefined) {
    if (typeof wire.s !== "object" || wire.s === null) {
      throw new RequestDecodeError("Link carries an invalid schedule.");
    }
    const candidate = {
      unit: WIRE_TO_UNIT[wire.s.u],
      every: wire.s.e,
      count: wire.s.c ?? null,
      anchor: wire.s.a,
    };
    if (!isValidSchedule(candidate)) {
      throw new RequestDecodeError("Link carries an invalid schedule.");
    }
    schedule = candidate;
  }

  return {
    id: wire.i,
    recipient: normalizeAddress(wire.r),
    recipientName: wire.n?.toLowerCase(),
    token: normalizeAddress(wire.t),
    amount,
    memo: wire.m,
    createdAt: wire.c,
    expiresAt: wire.e,
    schedule,
  };
}
