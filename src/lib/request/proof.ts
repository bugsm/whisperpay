import type { TypedData } from "starknet";

import { MAINNET_CHAIN_ID, normalizeAddress } from "@/lib/strk20/constants";

/**
 * Proving you're the recipient of a request, without the server knowing who
 * that is.
 *
 * The transaction hash is now kept against a request so the recipient can see
 * it — but it stays the one thing on this server that could unmask a payer, so
 * it is never handed to whoever merely holds the status link. Releasing it
 * takes a signature from the address the request was addressed to.
 *
 * Two pieces make that possible:
 *
 *   1. A **commitment** the payer's browser computes and reports alongside the
 *      transaction: `SHA-256(requestId : recipientAddress)`. The address itself
 *      never leaves the payer's browser, so the server stores something it
 *      can't read backwards, and a status record still names nobody.
 *
 *   2. A **typed message** the recipient signs to claim the request. The server
 *      verifies it against the account contract on-chain, so it works with any
 *      account implementation rather than only plain Stark-curve keys.
 *
 * The honest limits, since this is a commitment and not encryption: someone who
 * already has both the status id *and* a guess at the recipient address can
 * test that guess against the stored hash, and a reveal necessarily tells this
 * server the address doing the revealing. Neither is stored, and neither is
 * reachable by a stranger holding only the link.
 */

/** Salted with the request id, so one commitment can't be matched against another. */
export async function recipientCommitment(
  requestId: string,
  address: string
): Promise<string> {
  const payload = `${requestId}:${normalizeAddress(address)}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The message a recipient signs to see a payment's transaction hash.
 *
 * SNIP-12 revision 1. It names the request it's for, so a signature collected
 * for one request can't be replayed against another, and it says in plain words
 * what it authorises — wallets show this text, and "sign to continue" with no
 * stated purpose is how people get robbed.
 *
 * Every field is a `shortstring`, which caps at 31 characters: request ids are
 * 12, and an installment suffix adds at most 4.
 */
export function revealTypedData(requestId: string): TypedData {
  return {
    domain: {
      name: "Whisper Pay",
      version: "1",
      chainId: MAINNET_CHAIN_ID,
      revision: "1",
    },
    types: {
      StarknetDomain: [
        { name: "name", type: "shortstring" },
        { name: "version", type: "shortstring" },
        { name: "chainId", type: "shortstring" },
        { name: "revision", type: "shortstring" },
      ],
      Reveal: [
        { name: "action", type: "shortstring" },
        { name: "request", type: "shortstring" },
      ],
    },
    primaryType: "Reveal",
    message: {
      action: "Show my payment proof",
      request: requestId,
    },
  };
}
