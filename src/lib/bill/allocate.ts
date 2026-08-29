/**
 * Splitting an amount without losing a unit.
 *
 * `total / n` on `bigint` floors, so adding the pieces back up almost never
 * returns the total. At 18 decimals the gap is invisible to the eye and highly
 * visible in the one column a split-bill page exists to show: the sum of the
 * shares, sitting next to the total they're supposed to make.
 *
 * Used in two places — dividing a bill evenly, and pro-rating tax and service
 * across a scanned receipt (M8) — so it is defined once, here.
 */

/** Thrown for inputs that have no meaningful split. */
export class AllocationError extends Error {}

/**
 * Divide `total` into shares proportional to `weights`, losing nothing.
 *
 * Each share takes its floored portion, then the leftover units are handed out
 * one at a time to the shares with the largest remainders. The invariant is
 * exact for any weights: `allocate(total, w).reduce(sum) === total`.
 *
 * Ties break towards the lower index so the result is deterministic. That
 * matters beyond tidiness: a bill re-minted from the same numbers has to
 * produce the same links as the ones already shared, and a tie broken by
 * whatever order the runtime happened to sort in would quietly produce a
 * different set.
 *
 * All-zero weights are read as an even split rather than an error — that is
 * what "divide this between us, no weights given" means, and it keeps the
 * caller from special-casing it.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (total < 0n) {
    throw new AllocationError("Cannot allocate a negative total.");
  }
  if (weights.length === 0) return [];
  if (weights.some((weight) => weight < 0n)) {
    throw new AllocationError("Weights cannot be negative.");
  }

  let weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  let effective = weights;
  if (weightSum === 0n) {
    effective = weights.map(() => 1n);
    weightSum = BigInt(weights.length);
  }

  const shares = effective.map((weight) => (total * weight) / weightSum);
  const remainders = effective.map((weight) => (total * weight) % weightSum);

  // How many units the floors gave away. Always less than the number of
  // shares, so a single pass hands out every one of them.
  let leftover = total - shares.reduce((sum, share) => sum + share, 0n);

  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) =>
      a.remainder === b.remainder
        ? a.index - b.index
        : a.remainder > b.remainder
          ? -1
          : 1
    );

  for (const { index } of order) {
    if (leftover <= 0n) break;
    shares[index] += 1n;
    leftover -= 1n;
  }

  return shares;
}

/** The even split: `count` shares of `total`, differing by at most one unit. */
export function allocateEvenly(total: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new AllocationError("Need at least one share to split between.");
  }
  return allocate(total, new Array<bigint>(count).fill(1n));
}
