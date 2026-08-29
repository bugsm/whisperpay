/**
 * The split-bill data model.
 *
 * A bill is *not* a new kind of payment. It is a way of minting and watching a
 * set of ordinary payment requests at once: each share is turned into a
 * complete v1 `PaymentRequest` by `shareToRequest`, so `/pay/<payload>`,
 * `planPayment`, `PayClient`, transaction verification and the status store are
 * untouched by this feature. The payment path stays a single obligation with a
 * single amount, which is the part that most needs to stay simple.
 *
 * Like a request, a bill lives entirely in its own link. Nothing here is
 * written to a server, so the organiser page can't be broken by losing state —
 * and the server never learns who was at the table.
 */

/** Fewer than two people isn't a split. */
export const MIN_SHARES = 2;

/**
 * More than twenty and the link stops being sendable — twenty shares is already
 * around 1.8k characters of URL, and the right answer past that is two bills.
 */
export const MAX_SHARES = 20;

/** Long enough for a name, short enough that twenty of them still fit in a link. */
export const MAX_LABEL_LENGTH = 24;

/** "Dinner at Sate Khas Senayan" and not much more. */
export const MAX_TITLE_LENGTH = 60;

/**
 * The largest amount any share, or the total, may carry.
 *
 * A token amount is a `bigint` with no natural ceiling, and a payload is
 * attacker-supplied: without a bound, twenty shares of a 400-digit number are a
 * valid bill that renders as a wall of digits. 2^128 is far above every real
 * token supply and far below anything that could be mistaken for one.
 */
export const MAX_AMOUNT = 2n ** 128n;

export interface BillShare {
  /**
   * Who owes this line — free text ("bedu"), not an identity. It is never
   * resolved to an address and never verified; it exists so the organiser can
   * remember which link goes to which person.
   */
  label: string;
  /** This person's portion alone, in the token's smallest unit. */
  amount: bigint;
  /** What they ordered. Becomes the memo of the request derived from this line. */
  memo?: string;
}

/**
 * Fiat context captured when the link was minted. Display only.
 *
 * The binding number is always `BillShare.amount` in tokens. A bill is not a
 * rupiah-denominated invoice that floats with the price: if STRK moves between
 * minting and paying, what gets paid is the same amount of STRK. Carrying the
 * rate in the payload rather than fetching one at payment time is what keeps a
 * link payable with no server in the loop.
 *
 * Nothing writes this yet — the scanner in M8 does. It lives in the wire format
 * from the start so adding it later doesn't cost a version bump, which would
 * strand every link already shared.
 */
export interface FiatQuote {
  /** Currency code, uppercase — "IDR", "USD". */
  currency: string;
  /** Fiat minor units per whole token, as a decimal string. */
  rate: string;
  /** Unix seconds. Shown next to the converted figure, because a rate ages. */
  quotedAt: number;
}

export interface SplitBill {
  /** `newRequestId()` — 12 characters, ~72 bits. */
  id: string;
  /** One recipient for the whole bill. */
  recipient: string;
  /** `.stark` label the bill was created against. Cosmetic, as on a request. */
  recipientName?: string;
  /** Token contract address. One token per bill. */
  token: string;
  /** "Saturday dinner". Optional. */
  title?: string;
  shares: BillShare[];
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds. Absent means the links never expire. */
  expiresAt?: number;
  quote?: FiatQuote;
}

/**
 * The total, computed rather than carried.
 *
 * Storing a total next to the lines that make it up would mean two sources of
 * truth that can disagree — in a payload supplied by whoever sent the link.
 * There is only ever one number to trust here, and this is how it's obtained.
 */
export function billTotal(shares: readonly BillShare[]): bigint {
  return shares.reduce((sum, share) => sum + share.amount, 0n);
}
