/**
 * Routing a payment through the STRK20 pool.
 *
 * This is the core of Whisper Pay. A payer arriving from a link is in one of
 * two states, and the difference matters for both cost and privacy:
 *
 *   1. They already hold enough shielded balance → a single note-to-note
 *      `transfer`. Nothing about the payment is public: no amount, no parties.
 *
 *   2. They hold too little → `deposit` the shortfall and `transfer` the full
 *      amount, submitted as **one atomic STRK20 transaction**. The payer needs
 *      no prior setup beyond registering with the pool, which is what makes a
 *      one-link payment work at all.
 *
 * The deposit half of route 2 is public: shielding reveals the depositor, the
 * token and the amount. Only what happens afterwards is private. When the
 * deposit exactly equals the payment, those two public facts pin the private
 * transfer down — so `planPayment` flags that case and offers rounding to break
 * the equality. See `docs/PRIVACY.md` for the full accounting.
 */

import type { WALLET_API } from "@starknet-io/types-js";
import { ceilToMultiple } from "@/lib/amount";

export type PaymentStrategy = "private-transfer" | "shield-and-transfer";

export interface PaymentPlanInput {
  tokenAddress: string;
  /** Amount the request asks for, in the token's smallest unit. */
  amount: bigint;
  /** Recipient's Starknet address, as given in the payment link. */
  recipient: string;
  /** Payer's current shielded balance for this token. */
  shieldedBalance: bigint;
  /**
   * When set, round the deposit up to a multiple of this instead of depositing
   * the exact shortfall. Breaks the deposit-equals-payment correlation at the
   * cost of shielding more than the payment needs — the surplus stays in the
   * payer's private balance.
   */
  shieldRoundingStep?: bigint;
}

export interface PaymentPlan {
  strategy: PaymentStrategy;
  /** Submitted atomically via `walletAccount.strk20InvokeTransaction`. */
  actions: WALLET_API.STRK20_ACTION[];
  /** Public deposit into the pool. Zero for a pure private transfer. */
  depositAmount: bigint;
  /** Private note-to-note transfer. Always the full requested amount. */
  transferAmount: bigint;
  /** How much of the payment the existing shielded balance covers. */
  coveredByBalance: bigint;
  /** Deposited but not spent by this payment; stays shielded. */
  surplus: bigint;
  /**
   * The public deposit is exactly the private payment. An observer who sees
   * the deposit learns the payment amount, and the timing links it to this
   * transfer.
   */
  revealsAmount: boolean;
}

/** Hex-encode a smallest-unit amount for the wallet API's FELT fields. */
function toFelt(value: bigint): string {
  return `0x${value.toString(16)}`;
}

export function planPayment(input: PaymentPlanInput): PaymentPlan {
  const { tokenAddress, amount, recipient, shieldedBalance, shieldRoundingStep } =
    input;

  if (amount <= 0n) {
    throw new Error("Payment amount must be greater than zero.");
  }

  const coveredByBalance = shieldedBalance >= amount ? amount : shieldedBalance;
  const shortfall = amount - coveredByBalance;

  // Route 1 — the payer is already funded inside the pool. Fully private.
  if (shortfall === 0n) {
    return {
      strategy: "private-transfer",
      actions: [
        {
          type: "transfer",
          token: tokenAddress,
          amount: toFelt(amount),
          recipient,
        },
      ],
      depositAmount: 0n,
      transferAmount: amount,
      coveredByBalance,
      surplus: 0n,
      revealsAmount: false,
    };
  }

  // Route 2 — shield the shortfall and pay, atomically.
  const depositAmount = shieldRoundingStep
    ? ceilToMultiple(shortfall, shieldRoundingStep)
    : shortfall;

  return {
    strategy: "shield-and-transfer",
    actions: [
      { type: "deposit", token: tokenAddress, amount: toFelt(depositAmount) },
      {
        type: "transfer",
        token: tokenAddress,
        amount: toFelt(amount),
        recipient,
      },
    ],
    depositAmount,
    transferAmount: amount,
    coveredByBalance,
    surplus: depositAmount - shortfall,
    revealsAmount: depositAmount === amount,
  };
}

/**
 * Build the actions for moving a shielded balance back out to a public address
 * ("withdraw to spend"). Used by the recipient dashboard.
 */
export function planUnshield(
  tokenAddress: string,
  amount: bigint,
  recipient: string
): WALLET_API.STRK20_ACTION[] {
  if (amount <= 0n) {
    throw new Error("Withdrawal amount must be greater than zero.");
  }
  return [
    { type: "withdraw", token: tokenAddress, amount: toFelt(amount), recipient },
  ];
}
