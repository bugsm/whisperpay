/**
 * A scanned receipt: what it is, and what it is allowed to contain.
 *
 * **The model proposes; it never decides.** What comes back from a scan is a
 * draft the organiser edits before any link is minted. That is a structural
 * answer to a real limitation: warung receipts are creased, photographed at an
 * angle, and written with `.` as a thousands separator, so a misread line is a
 * matter of when rather than whether. Every number is editable in the UI, and a
 * total that disagrees with the lines is shown as a discrepancy rather than
 * quietly corrected — this feature has to stay useful when a line is misread.
 *
 * Kept apart from `./scan`, which is `server-only` and holds the API call. The
 * validation below is the part worth testing directly, and the browser needs
 * these types to render the draft — neither is possible from inside a module
 * that refuses to load outside a server component. Same split, and the same
 * reason, as `store/record.ts` against `store/index.ts`.
 */

export class NotaScanError extends Error {}

/** No `ANTHROPIC_API_KEY`. The feature is hidden rather than offered and broken. */
export class NotaConfigError extends NotaScanError {}

/** The API refused, rate-limited, or was unreachable. */
export class NotaUpstreamError extends NotaScanError {}

/** The model answered, and the answer isn't a receipt this code can use. */
export class NotaOutputError extends NotaScanError {}

/**
 * One line of a receipt.
 *
 * `amount` is the **line total** in the currency's smallest unit, as a decimal
 * string — the same rule as everywhere else in this codebase, and the reason
 * there is no `number` here. For rupiah the smallest unit is the rupiah, so
 * "12000" is Rp 12,000. Two portions of nasi goreng at Rp 25,000 are one line
 * with `quantity: 2` and `amount: "50000"`.
 */
/**
 * One person's claim on one line, as a weight rather than a sum of money.
 *
 * `quantity` is how many of that line they had — 1 for a shared dish, 2 for the
 * two of three teas that were theirs. It is deliberately not an amount: the
 * model reads who had what, and `allocate` divides the line, so no figure the
 * model produced is ever the number someone is asked to pay. That boundary is
 * the whole reason this shape exists instead of a per-person total.
 */
export interface NotaShare {
  name: string;
  quantity: number;
}

export interface NotaItem {
  name: string;
  quantity: number;
  amount: string;
  /**
   * Who had this line, when the organiser described it. Absent when they
   * didn't say — the UI then asks them to tap the names instead.
   */
  shares?: NotaShare[];
}

export interface ScannedNota {
  /** Whatever the header says, if anything. Free text, never trusted. */
  merchant?: string;
  /** ISO code the amounts are in. */
  currency: string;
  items: NotaItem[];
  /** Tax as printed, smallest unit. Absent when the receipt shows none. */
  tax?: string;
  service?: string;
  /** A discount line, as a positive number to be subtracted. */
  discount?: string;
  /** The printed grand total, when there is one. Never used to fix the lines. */
  total?: string;
}

/** What a photograph of a receipt may be. Enforced again in the route. */
export const ALLOWED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
] as const;

export type NotaMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

export function isAllowedMediaType(value: string): value is NotaMediaType {
  return (ALLOWED_MEDIA_TYPES as readonly string[]).includes(value);
}

/**
 * Rebuild a `ScannedNota` from whatever arrived, field by field.
 *
 * Not a cast, for the same reason `parseRecord` isn't one: this is generated
 * output, and a schema constrains it rather than guaranteeing it. Anything that
 * doesn't fit is refused here, where the message can say what was wrong, rather
 * than surfacing as a broken amount three screens later.
 *
 * Exported so it can be tested without a network call.
 */
export function parseNota(value: unknown): ScannedNota {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NotaOutputError("The scanner's answer wasn't a receipt.");
  }
  const raw = value as Record<string, unknown>;

  if (typeof raw.currency !== "string" || !/^[A-Za-z]{3}$/.test(raw.currency)) {
    throw new NotaOutputError("The scanner didn't say what currency that is.");
  }

  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new NotaOutputError(
      "No lines were found on that image. If it's a receipt, try a clearer photo."
    );
  }
  if (raw.items.length > MAX_ITEMS) {
    throw new NotaOutputError(
      `That receipt has more than ${MAX_ITEMS} lines — more than a bill can carry.`
    );
  }

  const items = raw.items.map((item) => parseItem(item));

  const nota: ScannedNota = {
    currency: raw.currency.toUpperCase(),
    items,
  };

  if (typeof raw.merchant === "string" && raw.merchant.trim() !== "") {
    nota.merchant = raw.merchant.trim().slice(0, MAX_NAME_LENGTH);
  }
  for (const field of ["tax", "service", "discount", "total"] as const) {
    const amount = optionalAmount(raw[field], field);
    if (amount !== undefined) nota[field] = amount;
  }

  return nota;
}

/** A receipt longer than this isn't going to become a twenty-person bill. */
const MAX_ITEMS = 60;

/** Long enough for "Nasi Goreng Spesial Pedas", short enough to render. */
const MAX_NAME_LENGTH = 60;

/**
 * The ceiling on any single figure.
 *
 * Sixteen digits of rupiah is more than a trillion — far past any restaurant
 * bill, and far below anything that would misbehave as a `bigint`. A misread
 * that turns "12.000" into a twenty-digit number is caught here rather than
 * becoming a payment request.
 */
const MAX_AMOUNT_DIGITS = 16;

function parseItem(value: unknown): NotaItem {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new NotaOutputError("One of the scanned lines wasn't readable.");
  }
  const raw = value as Record<string, unknown>;

  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    throw new NotaOutputError("One of the scanned lines has no name.");
  }
  if (
    typeof raw.quantity !== "number" ||
    !Number.isInteger(raw.quantity) ||
    raw.quantity < 1 ||
    raw.quantity > 999
  ) {
    throw new NotaOutputError(
      `"${raw.name}" came back with a quantity that isn't a whole number of things.`
    );
  }

  const amount = requiredAmount(raw.amount, raw.name);

  const item: NotaItem = {
    name: raw.name.trim().slice(0, MAX_NAME_LENGTH),
    quantity: raw.quantity,
    amount,
  };

  const shares = parseShares(raw.shares, item.name);
  if (shares.length > 0) item.shares = shares;

  return item;
}

/** More eaters on one line than a bill can hold lines. */
const MAX_EATERS = 20;

/**
 * Who had a line, rebuilt name by name.
 *
 * Absent, empty, or not a list all mean the same thing — nobody said — and
 * that is a state the UI has an answer for, so it is not an error. What *is*
 * refused is a malformed entry: a claim with no name, or a quantity that isn't
 * a whole number of things, would otherwise become a weight in an allocation
 * and quietly move money between people.
 *
 * Duplicate names are folded together rather than rejected. "adi - ayam, adi -
 * es teh" is a person listing their order in two breaths, not an ambiguity.
 */
function parseShares(value: unknown, label: string): NotaShare[] {
  if (!Array.isArray(value)) return [];

  const byName = new Map<string, NotaShare>();
  for (const entry of value.slice(0, MAX_EATERS)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new NotaOutputError(`"${label}" came back with an unreadable share.`);
    }
    const raw = entry as Record<string, unknown>;

    if (typeof raw.name !== "string" || raw.name.trim() === "") {
      throw new NotaOutputError(`"${label}" was given to somebody with no name.`);
    }
    if (
      typeof raw.quantity !== "number" ||
      !Number.isInteger(raw.quantity) ||
      raw.quantity < 1 ||
      raw.quantity > 999
    ) {
      throw new NotaOutputError(
        `"${label}" came back with a share that isn't a whole number of things.`
      );
    }

    const name = raw.name.trim().slice(0, MAX_NAME_LENGTH);
    const existing = byName.get(name.toLowerCase());
    if (existing) {
      existing.quantity = Math.min(999, existing.quantity + raw.quantity);
    } else {
      byName.set(name.toLowerCase(), { name, quantity: raw.quantity });
    }
  }

  return [...byName.values()];
}

function requiredAmount(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new NotaOutputError(
      `"${label}" came back with an amount that isn't a plain number.`
    );
  }
  if (value.length > MAX_AMOUNT_DIGITS) {
    throw new NotaOutputError(`"${label}" came back with an implausible amount.`);
  }
  // Leading zeros are harmless but never what a receipt says; normalising here
  // keeps "007" from rendering next to "7" as though they were different.
  return BigInt(value).toString();
}

function optionalAmount(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredAmount(value, label);
}

/**
 * What the lines add up to, against what the receipt claims.
 *
 * Returned as a difference rather than applied as a correction. The organiser
 * is holding the paper; they can see which of the two is wrong, and this code
 * cannot.
 */
export function notaTotals(nota: ScannedNota): {
  items: bigint;
  computed: bigint;
  printed?: bigint;
  /** `computed - printed`, when the receipt printed a total. */
  difference?: bigint;
} {
  const items = nota.items.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  const computed =
    items +
    BigInt(nota.tax ?? 0) +
    BigInt(nota.service ?? 0) -
    BigInt(nota.discount ?? 0);

  if (nota.total === undefined) return { items, computed };

  const printed = BigInt(nota.total);
  return { items, computed, printed, difference: computed - printed };
}
