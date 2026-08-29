/**
 * The one invariant a split-bill page lives on: the parts add up to the whole.
 *
 * `total / n` floors, so the naive split is short by up to `n - 1` units. At 18
 * decimals nobody would see the difference in any single row — they would see
 * it in the column that shows the shares next to the total they are supposed to
 * make, which is the column this feature exists to show.
 *
 * The property test below is deterministic on purpose: a seeded generator, so a
 * failure here is a failure anyone can reproduce rather than a case that
 * appeared once in CI.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allocate, allocateEvenly, AllocationError } from "@/lib/bill/allocate";

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

/** xorshift32 — small, deterministic, and not a dependency. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

describe("allocate keeps every unit", () => {
  it("splits evenly when it divides", () => {
    assert.deepEqual(allocate(9n, [1n, 1n, 1n]), [3n, 3n, 3n]);
  });

  it("hands the remainder out one unit at a time", () => {
    assert.deepEqual(allocate(10n, [1n, 1n, 1n]), [4n, 3n, 3n]);
    assert.equal(sum(allocate(10n, [1n, 1n, 1n])), 10n);
  });

  it("follows the weights", () => {
    assert.deepEqual(allocate(100n, [1n, 4n]), [20n, 80n]);
    assert.deepEqual(allocate(7n, [3n, 1n]), [5n, 2n]);
  });

  it("reads all-zero weights as an even split", () => {
    // "Divide this between us, no weights given" — an error here would only
    // push the same special case into every caller.
    assert.deepEqual(allocate(10n, [0n, 0n, 0n]), [4n, 3n, 3n]);
  });

  it("gives a zero total zero shares", () => {
    assert.deepEqual(allocate(0n, [1n, 2n, 3n]), [0n, 0n, 0n]);
  });

  it("handles no shares at all", () => {
    assert.deepEqual(allocate(100n, []), []);
  });

  it("refuses a negative total and negative weights", () => {
    assert.throws(() => allocate(-1n, [1n, 1n]), AllocationError);
    assert.throws(() => allocate(10n, [1n, -1n]), AllocationError);
  });

  it("is deterministic, ties broken towards the lower index", () => {
    // A re-minted bill has to produce the links that were already shared, so
    // "which share got the spare unit" cannot depend on sort stability.
    const once = allocate(11n, [1n, 1n, 1n, 1n, 1n]);
    assert.deepEqual(once, [3n, 2n, 2n, 2n, 2n]);
    assert.deepEqual(allocate(11n, [1n, 1n, 1n, 1n, 1n]), once);
  });

  it("sums to the total for a wide sweep of totals and weights", () => {
    const random = seeded(20260829);

    for (let round = 0; round < 500; round += 1) {
      const count = 1 + Math.floor(random() * 20);
      const weights = Array.from({ length: count }, () =>
        BigInt(Math.floor(random() * 1_000_000))
      );
      // Amounts on this scale are what an 18-decimal token actually carries.
      const total =
        BigInt(Math.floor(random() * 1_000_000)) * 10n ** 12n +
        BigInt(Math.floor(random() * 1_000_000));

      const shares = allocate(total, weights);

      assert.equal(shares.length, count);
      assert.equal(sum(shares), total, `round ${round} lost or gained a unit`);
      assert.ok(
        shares.every((share) => share >= 0n),
        `round ${round} produced a negative share`
      );
      assert.deepEqual(allocate(total, weights), shares);
    }
  });

  it("never spreads a share further than one unit apart on an even split", () => {
    for (const count of [2, 3, 7, 20]) {
      for (const total of [0n, 1n, 5n, 999n, 10n ** 18n + 7n]) {
        const shares = allocateEvenly(total, count);
        assert.equal(sum(shares), total);
        const min = shares.reduce((a, b) => (a < b ? a : b));
        const max = shares.reduce((a, b) => (a > b ? a : b));
        assert.ok(max - min <= 1n);
      }
    }
  });

  it("refuses to split between nobody", () => {
    assert.throws(() => allocateEvenly(10n, 0), AllocationError);
    assert.throws(() => allocateEvenly(10n, 1.5), AllocationError);
  });
});
