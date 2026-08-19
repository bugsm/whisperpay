/**
 * Reading a payment plan back to the payer, in plain terms.
 *
 * `planPayment` already decides everything that matters for privacy: which
 * route this payment takes, what the public deposit will say, and whether that
 * deposit happens to equal the payment. This module turns those decisions into
 * a claim specific enough to be checked against the numbers on screen — not a
 * disclaimer that would read the same whatever the plan said.
 *
 * It adds no routing logic of its own. Every branch here corresponds to a field
 * `planPayment` already computed; the one genuinely new judgement is whether
 * the amount is distinctive enough to identify itself, which is advisory and
 * never blocks a payment.
 */

import { formatDisplay, significantDecimals } from "@/lib/amount";
import type { TokenInfo } from "./constants";
import type { PaymentPlan } from "./plan";

/**
 * How much this specific payment publishes.
 *
 * - `strong` — nothing goes public. A note-to-note transfer inside the pool.
 * - `moderate` — a public deposit happens, but it doesn't state the payment.
 * - `weak` — the public deposit is exactly the payment, which publishes it.
 */
export type PrivacyLevel = "strong" | "moderate" | "weak";

export interface PrivacyAssessment {
  level: PrivacyLevel;
  /** Two or three words, for the meter itself. */
  label: string;
  /** One sentence, quoting this plan's actual numbers. */
  detail: string;
  /**
   * Advisory note when the amount is unusual enough to identify itself.
   * Never a reason to stop — hence separate from `level`.
   */
  fingerprintNote?: string;
}

/**
 * Decimal places past which an amount stops looking like a price and starts
 * looking like a serial number. Two covers ordinary money ("12.50"); a payment
 * carried to four or more is distinctive enough to recognise again.
 */
const DISTINCTIVE_DECIMALS = 4;

export function assessPrivacy(
  plan: PaymentPlan,
  token: TokenInfo
): PrivacyAssessment {
  const fmt = (value: bigint) =>
    `${formatDisplay(value, token.decimals)} ${token.symbol}`;

  const assessment = describeRoute(plan, fmt);

  // Independent of the route: a transfer hides its amount, but a precise enough
  // amount identifies itself anywhere it does surface.
  //
  // Described by its precision rather than quoted back, deliberately. Display
  // formatting caps at six decimals, so quoting a nine-decimal amount here
  // would print a figure that isn't the one being warned about.
  const decimals = significantDecimals(plan.transferAmount, token.decimals);
  if (decimals >= DISTINCTIVE_DECIMALS) {
    const surfaces =
      plan.depositAmount > 0n
        ? "the deposit above, or a withdrawal of a matching size later"
        : "a withdrawal of a matching size later, say";
    assessment.fingerprintNote =
      `This amount is specified to ${decimals} decimal places. The transfer ` +
      `itself hides it, but anywhere it does surface — ${surfaces} — a figure ` +
      `that precise is easy to match back to this payment. Rounder amounts blend in.`;
  }

  return assessment;
}

function describeRoute(
  plan: PaymentPlan,
  fmt: (value: bigint) => string
): PrivacyAssessment {
  // Route 1 — funded payer. Nothing public happens at all.
  if (plan.strategy === "private-transfer") {
    return {
      level: "strong",
      label: "Nothing goes public",
      detail:
        `You're paying ${fmt(plan.transferAmount)} entirely from your shielded ` +
        `balance, so this transaction publishes no deposit to correlate: no ` +
        `amount, no sender, no recipient.`,
    };
  }

  // Route 2, worst case — the deposit is the payment, stated in public.
  if (plan.revealsAmount) {
    return {
      level: "weak",
      label: "Deposit reveals the amount",
      detail:
        `The public deposit is exactly the ${fmt(plan.transferAmount)} you're ` +
        `paying, so anyone watching the pool can read the amount off it and tie ` +
        `it to this payment by timing.`,
    };
  }

  // Route 2, deposit deliberately larger than the payment.
  if (plan.surplus > 0n) {
    return {
      level: "moderate",
      label: "Amount not stated",
      detail:
        `Paying ${fmt(plan.transferAmount)} — the deposit is rounded up to ` +
        `${fmt(plan.depositAmount)}, so the public leg says ` +
        `"${fmt(plan.depositAmount)} shielded", not what you paid. The extra ` +
        `${fmt(plan.surplus)} stays in your shielded balance.`,
    };
  }

  // Route 2 with a partial balance: the deposit covers the shortfall only, so
  // it's already smaller than the payment without any rounding.
  return {
    level: "moderate",
    label: "Amount not stated",
    detail:
      `Paying ${fmt(plan.transferAmount)}, of which ` +
      `${fmt(plan.coveredByBalance)} comes from your shielded balance. The ` +
      `public deposit is ${fmt(plan.depositAmount)} — the shortfall, not the ` +
      `payment.`,
  };
}
