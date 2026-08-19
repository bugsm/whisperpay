/**
 * The routing and privacy claims Whisper Pay makes to a payer.
 *
 * These are the load-bearing assertions in the README: that the route is chosen
 * from the payer's shielded balance, that over-funding breaks the
 * deposit-equals-payment correlation — and, just as importantly, the cases
 * where it *doesn't* and the app is expected to keep saying so.
 *
 * Run with `npm test`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseUnits } from "@/lib/amount";
import type { TokenInfo } from "@/lib/strk20/constants";
import { planPayment } from "@/lib/strk20/plan";
import { assessPrivacy } from "@/lib/strk20/privacy";

const STRK: TokenInfo = {
  symbol: "STRK",
  name: "Starknet Token",
  address: "0x1",
  decimals: 18,
  shieldRoundingStep: 10n * 10n ** 18n,
};

const strk = (value: string) => parseUnits(value, STRK.decimals);

/** A plan for `amount`, paid by someone holding `balance`. */
function plan(amount: string, balance: string, roundUp = false) {
  return planPayment({
    tokenAddress: STRK.address,
    recipient: "0x2",
    amount: strk(amount),
    shieldedBalance: strk(balance),
    shieldRoundingStep: roundUp ? STRK.shieldRoundingStep : undefined,
  });
}

describe("planPayment — route selection", () => {
  it("pays note-to-note when the payer is already funded", () => {
    const p = plan("12.4", "50");
    assert.equal(p.strategy, "private-transfer");
    assert.deepEqual(
      p.actions.map((a) => a.type),
      ["transfer"]
    );
    assert.equal(p.depositAmount, 0n, "a funded payer publishes no deposit");
    assert.equal(p.revealsAmount, false);
  });

  it("treats an exactly-sufficient balance as funded", () => {
    assert.equal(plan("12.4", "12.4").strategy, "private-transfer");
  });

  it("bundles deposit and transfer atomically when the payer is short", () => {
    const p = plan("12.4", "0");
    assert.equal(p.strategy, "shield-and-transfer");
    assert.deepEqual(
      p.actions.map((a) => a.type),
      ["deposit", "transfer"],
      "both actions go to the wallet as one STRK20 transaction"
    );
  });

  it("deposits only the shortfall when the balance covers part of it", () => {
    const p = plan("12.4", "5");
    assert.equal(p.depositAmount, strk("7.4"));
    assert.equal(p.coveredByBalance, strk("5"));
    assert.equal(p.transferAmount, strk("12.4"), "the full amount still moves");
    assert.equal(
      p.revealsAmount,
      false,
      "a partial deposit already differs from the payment"
    );
  });

  it("rejects a non-positive amount", () => {
    assert.throws(() => plan("0", "50"));
  });
});

describe("planPayment — the deposit-equals-payment correlation", () => {
  it("flags the zero-balance case, where the deposit states the payment", () => {
    const p = plan("12.4", "0");
    assert.equal(p.depositAmount, p.transferAmount);
    assert.equal(p.revealsAmount, true);
  });

  it("breaks the equality when over-funding is enabled", () => {
    const p = plan("12.4", "0", true);
    assert.equal(p.depositAmount, strk("20"), "rounded up to the next 10 STRK");
    assert.equal(p.surplus, strk("7.6"));
    assert.equal(p.revealsAmount, false);
    assert.equal(p.transferAmount, strk("12.4"), "the payment itself is unchanged");
  });

  it("still flags an amount that is already a multiple of the step", () => {
    // The honest edge case: rounding 20 up to the next 10 is still 20, so the
    // deposit goes on stating the payment. The flag has to survive rounding.
    const p = plan("20", "0", true);
    assert.equal(p.depositAmount, strk("20"));
    assert.equal(p.surplus, 0n);
    assert.equal(p.revealsAmount, true, "rounding did not help here");
  });

  it("rounds deterministically, not randomly", () => {
    const runs = Array.from({ length: 5 }, () => plan("12.4", "0", true));
    for (const p of runs) {
      assert.equal(p.depositAmount, runs[0].depositAmount);
    }
    assert.equal(runs[0].depositAmount, strk("20"));
  });
});

describe("assessPrivacy — what the payer is told", () => {
  it("reports nothing public for a funded payer", () => {
    const a = assessPrivacy(plan("12.4", "50"), STRK);
    assert.equal(a.level, "strong");
    assert.match(a.detail, /12\.4 STRK/);
    assert.match(a.detail, /no deposit/);
  });

  it("warns when the deposit states the payment", () => {
    const a = assessPrivacy(plan("12.4", "0"), STRK);
    assert.equal(a.level, "weak");
    assert.match(a.detail, /exactly the 12\.4 STRK/);
  });

  it("quotes both figures once the deposit is over-funded", () => {
    const a = assessPrivacy(plan("12.4", "0", true), STRK);
    assert.equal(a.level, "moderate");
    assert.match(a.detail, /12\.4 STRK/, "the amount actually paid");
    assert.match(a.detail, /20 STRK/, "the larger public deposit");
    assert.match(a.detail, /7\.6 STRK/, "the surplus left shielded");
  });

  it("stays honest when rounding changed nothing", () => {
    const a = assessPrivacy(plan("20", "0", true), STRK);
    assert.equal(
      a.level,
      "weak",
      "round-up is on, but it did not break the equality"
    );
  });

  it("describes a partial deposit as the shortfall, not the payment", () => {
    const a = assessPrivacy(plan("12.4", "5"), STRK);
    assert.equal(a.level, "moderate");
    assert.match(a.detail, /shortfall/);
  });
});

describe("assessPrivacy — distinctive amounts", () => {
  it("says nothing about an ordinary amount", () => {
    assert.equal(assessPrivacy(plan("12.5", "50"), STRK).fingerprintNote, undefined);
    assert.equal(assessPrivacy(plan("12", "50"), STRK).fingerprintNote, undefined);
  });

  it("flags an amount precise enough to identify itself", () => {
    const a = assessPrivacy(plan("12.4173829", "50"), STRK);
    assert.ok(a.fingerprintNote);
    assert.match(a.fingerprintNote, /7 decimal places/);
  });

  it("does not mention a deposit when there is no deposit", () => {
    // A funded payer publishes nothing, so pointing at "the deposit above"
    // would describe a row that isn't on screen.
    const a = assessPrivacy(plan("12.4173829", "50"), STRK);
    assert.doesNotMatch(a.fingerprintNote!, /deposit/);
  });

  it("points at the deposit when there is one", () => {
    const a = assessPrivacy(plan("12.4173829", "0", true), STRK);
    assert.match(a.fingerprintNote!, /deposit above/);
  });

  it("is advisory only — it never changes the level", () => {
    const ordinary = assessPrivacy(plan("12.5", "50"), STRK);
    const precise = assessPrivacy(plan("12.4173829", "50"), STRK);
    assert.equal(precise.level, ordinary.level);
  });
});
