/**
 * Fixed-point amount helpers.
 *
 * Token amounts are handled as `bigint` in the token's smallest unit everywhere
 * in this codebase. Human-facing strings are only produced at the edges (UI,
 * link payloads). Nothing here touches `number`, so 18-decimal amounts survive
 * a round trip intact.
 */

/** Thrown when a user-supplied amount string can't be represented exactly. */
export class AmountError extends Error {}

/**
 * Parse a decimal string ("1", "1.5", "0.000001") into the token's smallest
 * unit. Rejects anything that would silently lose precision rather than
 * truncating, so a typo'd amount fails loudly instead of underpaying.
 */
export function parseUnits(value: string, decimals: number): bigint {
  const trimmed = value.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new AmountError(`"${value}" is not a valid amount.`);
  }

  const [whole = "", fraction = ""] = trimmed.split(".");
  if (fraction.length > decimals) {
    throw new AmountError(
      `Too many decimal places — this token supports at most ${decimals}.`
    );
  }

  const padded = fraction.padEnd(decimals, "0");
  return BigInt(`${whole || "0"}${padded}`);
}

/**
 * Render a smallest-unit amount as a plain decimal string, trailing zeros
 * removed ("1", "1.5"). No thousands separators — this is the round-trip
 * inverse of `parseUnits`, not a display formatter.
 */
export function formatUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fraction ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/**
 * Human-readable amount with thousands separators, capped at `maxFraction`
 * decimal places. For display only — never feed the result back into
 * `parseUnits`.
 */
export function formatDisplay(
  value: bigint,
  decimals: number,
  maxFraction = 6
): string {
  const exact = formatUnits(value, decimals);
  const [whole, fraction] = exact.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  if (!fraction) return grouped;
  const clipped = fraction.slice(0, maxFraction).replace(/0+$/, "");
  return clipped ? `${grouped}.${clipped}` : grouped;
}

/** Round `value` up to the next multiple of `step`. `step <= 0` is a no-op. */
export function ceilToMultiple(value: bigint, step: bigint): bigint {
  if (step <= 0n) return value;
  const remainder = value % step;
  return remainder === 0n ? value : value + (step - remainder);
}
