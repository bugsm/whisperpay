/**
 * Encoding a split bill into a link, and back.
 *
 * Same shape as the request codec next door: a compact JSON object with
 * one-letter keys, base64url-encoded, carried in the URL path. Nothing is
 * signed and nothing is stored, so the payload arrives entirely
 * attacker-controlled — `decodeBill` validates every field and refuses whatever
 * it does not fully understand, exactly as `decodeRequest` does.
 *
 * The version is 3, continuing the request codec's numbering rather than
 * starting its own. The two formats share one namespace of version numbers, and
 * `decodeRequest` already answers anything outside `1 | 2` with "made by a newer
 * version of Whisper Pay" — which is the right thing for an older build to say
 * when someone opens a bill link in it.
 */

import { isStarkDomain } from "@/lib/identity/encoding";
import { base64UrlToBytes, bytesToBase64Url } from "@/lib/request/codec";
import { RATE_SCALE } from "@/lib/quote";
import { MAX_MEMO_LENGTH } from "@/lib/request/types";
import { findToken, isValidAddress, normalizeAddress } from "@/lib/strk20/constants";
import {
  billTotal,
  MAX_AMOUNT,
  MAX_LABEL_LENGTH,
  MAX_SHARES,
  MAX_TITLE_LENGTH,
  MIN_SHARES,
  type BillShare,
  type FiatQuote,
  type SplitBill,
} from "./types";

export class BillDecodeError extends Error {}

/** Compact wire shape. Short keys keep a twenty-person link sendable. */
interface BillWire {
  /** 3. Shares the version namespace with `Wire` in the request codec. */
  v: 3;
  i: string;
  r: string;
  t: string;
  c: number;
  /** Optional `.stark` display label for the recipient. */
  n?: string;
  /** Title. */
  m?: string;
  e?: number;
  /** Shares: label, amount (decimal string, smallest unit), note. */
  h: Array<{ l: string; a: string; m?: string }>;
  /** Fiat context: currency, rate, quotedAt. Display only — see `FiatQuote`. */
  p?: { c: string; r: string; q: number };
}

export function encodeBill(bill: SplitBill): string {
  const wire: BillWire = {
    v: 3,
    i: bill.id,
    r: bill.recipient,
    t: bill.token,
    c: bill.createdAt,
    h: bill.shares.map((share) => {
      const line: BillWire["h"][number] = {
        l: share.label,
        a: share.amount.toString(),
      };
      if (share.memo) line.m = share.memo;
      return line;
    }),
  };
  if (bill.recipientName) wire.n = bill.recipientName;
  if (bill.title) wire.m = bill.title;
  if (bill.expiresAt !== undefined) wire.e = bill.expiresAt;
  if (bill.quote) {
    wire.p = {
      c: bill.quote.currency,
      r: bill.quote.rate,
      q: bill.quote.quotedAt,
    };
  }

  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(wire)));
}

/** The organiser page for a bill. The payload *is* the address. */
export function billPath(encoded: string): string {
  return `/bill/${encoded}`;
}

export function decodeBill(encoded: string): SplitBill {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
  } catch {
    // `base64UrlToBytes` throws the request codec's error type; a bill link
    // should never surface that name, so both failures answer as one.
    throw new BillDecodeError("Bill link isn't readable.");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BillDecodeError("Bill link payload isn't an object.");
  }
  const wire = parsed as Partial<BillWire>;

  if (wire.v !== 3) {
    throw new BillDecodeError(
      "This link was made by a newer version of Whisper Pay."
    );
  }

  if (typeof wire.i !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(wire.i)) {
    throw new BillDecodeError("Bill link is missing a valid id.");
  }

  if (typeof wire.r !== "string" || !isValidAddress(wire.r)) {
    throw new BillDecodeError("Bill link doesn't carry a valid recipient address.");
  }

  if (typeof wire.t !== "string" || !isValidAddress(wire.t)) {
    throw new BillDecodeError("Bill link doesn't carry a valid token address.");
  }
  if (!findToken(wire.t)) {
    throw new BillDecodeError(
      "This bill asks for a token Whisper Pay doesn't support."
    );
  }

  if (typeof wire.c !== "number" || !Number.isFinite(wire.c) || wire.c <= 0) {
    throw new BillDecodeError("Bill link doesn't carry a valid creation time.");
  }

  if (
    wire.e !== undefined &&
    (typeof wire.e !== "number" || !Number.isFinite(wire.e) || wire.e <= 0)
  ) {
    throw new BillDecodeError("Bill link carries an invalid expiry.");
  }

  if (wire.m !== undefined) {
    if (typeof wire.m !== "string") {
      throw new BillDecodeError("Bill link carries an invalid title.");
    }
    if (wire.m.length > MAX_TITLE_LENGTH) {
      throw new BillDecodeError("Bill link's title is too long.");
    }
  }

  // Held to the same standard as on a request: this label is rendered next to a
  // real address, so a malformed one is refused rather than displayed.
  if (wire.n !== undefined) {
    if (typeof wire.n !== "string" || !isStarkDomain(wire.n.toLowerCase())) {
      throw new BillDecodeError("Bill link carries an invalid recipient name.");
    }
  }

  if (!Array.isArray(wire.h)) {
    throw new BillDecodeError("Bill link doesn't carry a list of shares.");
  }
  if (wire.h.length < MIN_SHARES) {
    throw new BillDecodeError(
      `A bill needs at least ${MIN_SHARES} shares — one share is just a payment request.`
    );
  }
  if (wire.h.length > MAX_SHARES) {
    throw new BillDecodeError(
      `A bill can hold at most ${MAX_SHARES} shares. Split it into two.`
    );
  }

  const shares: BillShare[] = wire.h.map((line) => decodeShare(line));

  // Computed, never trusted — and bounded, because twenty shares that each sit
  // just under the ceiling still add up to something no token can express.
  if (billTotal(shares) >= MAX_AMOUNT) {
    throw new BillDecodeError("Bill link's total isn't a plausible amount.");
  }

  return {
    id: wire.i,
    recipient: normalizeAddress(wire.r),
    recipientName: wire.n?.toLowerCase(),
    token: normalizeAddress(wire.t),
    title: wire.m,
    shares,
    createdAt: wire.c,
    expiresAt: wire.e,
    quote: wire.p === undefined ? undefined : decodeQuote(wire.p),
  };
}

function decodeShare(value: unknown): BillShare {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BillDecodeError("Bill link carries a share that isn't readable.");
  }
  const line = value as Partial<BillWire["h"][number]>;

  if (typeof line.l !== "string" || line.l.trim() === "") {
    throw new BillDecodeError("A share on this bill has no name.");
  }
  const label = line.l.trim();
  if (label.length > MAX_LABEL_LENGTH) {
    throw new BillDecodeError(
      `A name on this bill is longer than ${MAX_LABEL_LENGTH} characters.`
    );
  }

  if (typeof line.a !== "string" || !/^\d+$/.test(line.a)) {
    throw new BillDecodeError("A share on this bill has no valid amount.");
  }
  const amount = BigInt(line.a);
  if (amount <= 0n) {
    throw new BillDecodeError("Every share must be greater than zero.");
  }
  if (amount >= MAX_AMOUNT) {
    throw new BillDecodeError("A share on this bill isn't a plausible amount.");
  }

  if (line.m !== undefined) {
    if (typeof line.m !== "string") {
      throw new BillDecodeError("A share on this bill has an invalid note.");
    }
    if (line.m.length > MAX_MEMO_LENGTH) {
      throw new BillDecodeError("A note on this bill is too long.");
    }
  }

  return { label, amount, memo: line.m };
}

/**
 * A rate this build can actually divide with.
 *
 * `fiatToTokenUnits` parses the rate at `RATE_SCALE` places and throws on
 * anything finer, so `^\d+(\.\d+)?$` was too generous: a payload carrying a
 * ninth decimal decoded cleanly here and then threw out of the page that
 * renders it — past `/bill/[id]`'s catch, which only wraps the decode, giving a
 * 500 where the "isn't valid" card belongs. The scale is read from the module
 * that enforces it so the two cannot drift apart.
 */
const RATE_PATTERN = new RegExp(`^\\d+(\\.\\d{1,${RATE_SCALE}})?$`);

/**
 * The fiat context, validated like everything else even though it is only ever
 * displayed. A rate rendering as `NaN` beside a real amount is worse than no
 * rate at all — the reader can't tell which of the two numbers to trust.
 */
function decodeQuote(value: unknown): FiatQuote {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BillDecodeError("Bill link carries an invalid exchange rate.");
  }
  const quote = value as Partial<NonNullable<BillWire["p"]>>;

  if (typeof quote.c !== "string" || !/^[A-Z]{3,8}$/.test(quote.c)) {
    throw new BillDecodeError("Bill link carries an invalid currency.");
  }
  if (
    typeof quote.r !== "string" ||
    !RATE_PATTERN.test(quote.r) ||
    Number(quote.r) <= 0
  ) {
    throw new BillDecodeError("Bill link carries an invalid exchange rate.");
  }
  if (typeof quote.q !== "number" || !Number.isFinite(quote.q) || quote.q <= 0) {
    throw new BillDecodeError("Bill link carries an invalid rate timestamp.");
  }

  return { currency: quote.c, rate: quote.r, quotedAt: quote.q };
}
