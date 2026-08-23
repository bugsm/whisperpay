import { mainnetProvider } from "./provider";
import { POOL_ADDRESS, sameAddress } from "./constants";

/**
 * Verifying that a reported transaction really touched the STRK20 pool.
 *
 * This is deliberately the *only* thing the server checks, and it's worth being
 * precise about why. A private transfer carries no readable amount and no
 * readable parties, and it's submitted by a rotating relayer rather than the
 * payer's own account. So from a transaction hash alone, anyone — us included —
 * can establish that a successful transaction exists and that the pool emitted
 * an event in it. Nobody can establish that it paid *this* request.
 *
 * That's the privacy guarantee working as intended, not a gap to paper over.
 * The UI reflects it: a verified hash moves a request to `submitted`, and only
 * the recipient, reading their own shielded balance, can move it to
 * `confirmed`.
 */
export interface PoolTxVerification {
  ok: boolean;
  /** Why verification failed, for display. */
  reason?: string;
  /**
   * The chain has no receipt for this hash *yet*. Distinct from every other
   * failure here, all of which are final: a reverted transaction stays
   * reverted, and one that missed the pool never touches it later. This one
   * is just early, and is the normal answer for a transaction submitted
   * seconds ago — so it's the only failure worth waiting out.
   */
  notFound?: boolean;
  executionStatus?: string;
  finalityStatus?: string;
  /** Events in the receipt emitted by the pool contract. */
  poolEventCount: number;
}

/**
 * The same check, but willing to wait for a transaction that hasn't landed.
 *
 * A pool transaction verifies a STARK proof on-chain, so there's a gap of
 * seconds to minutes between a wallet handing back a hash and the chain
 * having a receipt to read. Checking once inside that gap always fails, which
 * left the payer's browser as the only thing that could report the payment —
 * and payers close the tab as soon as their wallet says it worked.
 *
 * So the wait moves here, where nothing depends on a tab staying open. The
 * hash still exists only for the duration of this call: it is read from the
 * request, checked, and dropped. Nothing about that changes, and
 * `status-privacy.test.ts` still holds the record to four fields.
 *
 * Bounded by `budgetMs` because this runs inside a serverless request with a
 * hard ceiling. When the budget runs out the last verdict is returned as-is;
 * the caller reports a failure and the recipient's own "Mark received" stays
 * the fallback it always was.
 */
export async function awaitPoolTransaction(
  txHash: string,
  budgetMs = 35_000,
  intervalMs = 3_000
): Promise<PoolTxVerification> {
  const deadline = Date.now() + budgetMs;
  let verification = await verifyPoolTransaction(txHash);

  while (!verification.ok && verification.notFound) {
    // Checked before sleeping, and with room for the round trip that
    // follows: the RPC client sets no timeout of its own, so a call started
    // near the deadline can outlive the whole invocation and take the
    // store write with it — after the verification succeeded.
    if (deadline - Date.now() <= intervalMs * 2) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    verification = await verifyPoolTransaction(txHash);
  }

  return verification;
}

/** Finality states a transaction can't be taken back from. */
const ACCEPTED_FINALITY = new Set(["ACCEPTED_ON_L2", "ACCEPTED_ON_L1"]);

export function isValidTxHash(hash: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(hash.trim());
}

export async function verifyPoolTransaction(
  txHash: string
): Promise<PoolTxVerification> {
  if (!isValidTxHash(txHash)) {
    return { ok: false, reason: "Not a valid transaction hash.", poolEventCount: 0 };
  }

  let receipt: Record<string, unknown>;
  try {
    const response = await mainnetProvider.getTransactionReceipt(txHash);
    // starknet.js may hand back a wrapper around the raw receipt.
    const unwrapped = (response as { value?: unknown })?.value ?? response;
    receipt = unwrapped as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      reason: "Transaction not found on Starknet mainnet.",
      notFound: true,
      poolEventCount: 0,
    };
  }

  const executionStatus = receipt.execution_status as string | undefined;
  const finalityStatus = receipt.finality_status as string | undefined;

  if (executionStatus === "REVERTED") {
    return {
      ok: false,
      reason: "Transaction reverted on-chain.",
      executionStatus,
      finalityStatus,
      poolEventCount: 0,
    };
  }

  // A receipt can exist before the transaction is in a block: RPC 0.9 answers
  // `PRE_CONFIRMED` for one the sequencer has executed but not yet sealed,
  // and such a transaction can still be dropped. Settling on it would mark a
  // request received forever on the strength of something that never
  // happened — and since the hash isn't kept, nothing could ever correct it.
  //
  // Treated as not-found rather than as a failure, because that is what it
  // is: too early. `awaitPoolTransaction` will look again.
  if (!ACCEPTED_FINALITY.has(finalityStatus ?? "")) {
    return {
      ok: false,
      reason: `Transaction isn't final yet (${finalityStatus ?? "unknown"}).`,
      notFound: true,
      executionStatus,
      finalityStatus,
      poolEventCount: 0,
    };
  }

  const events = Array.isArray(receipt.events)
    ? (receipt.events as { from_address?: string }[])
    : [];
  const poolEventCount = events.filter((event) =>
    event.from_address ? sameAddress(event.from_address, POOL_ADDRESS) : false
  ).length;

  if (poolEventCount === 0) {
    return {
      ok: false,
      reason: "Transaction succeeded but didn't touch the STRK20 pool.",
      executionStatus,
      finalityStatus,
      poolEventCount,
    };
  }

  return { ok: true, executionStatus, finalityStatus, poolEventCount };
}
