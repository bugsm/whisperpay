import { mainnetProvider } from "./provider";
import { POOL_ADDRESS, normalizeAddress } from "./constants";

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
  executionStatus?: string;
  finalityStatus?: string;
  /** Events in the receipt emitted by the pool contract. */
  poolEventCount: number;
}

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

  const events = Array.isArray(receipt.events)
    ? (receipt.events as { from_address?: string }[])
    : [];
  const pool = normalizeAddress(POOL_ADDRESS);
  const poolEventCount = events.filter((event) => {
    try {
      return event.from_address
        ? normalizeAddress(event.from_address) === pool
        : false;
    } catch {
      return false;
    }
  }).length;

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
