import type { TypedData } from "starknet";

import { MAINNET_CHAIN_ID, isValidAddress } from "@/lib/strk20/constants";
import { bytesToBase64Url, base64UrlToBytes } from "./codec";

/**
 * Signed receipts — a recipient's own word that a request was paid, made
 * checkable by anyone.
 *
 * This is a signed receipt, not a proof of payment, and the distinction is the
 * whole point rather than a caveat. What a verifier learns is that whoever
 * holds the recipient account's key asserted a specific sentence about a
 * specific request. That is exactly the trust model of a signed paper receipt:
 * non-repudiable, and worth precisely as much as the signer's word.
 *
 * It is emphatically **not** a zero-knowledge proof, and nothing here should
 * ever be described as one. Proving "a transfer of at least X reached my
 * address" without revealing X would mean proving statements about the pool's
 * note commitments — a custom Cairo circuit, a verifier contract, and prover
 * integration. Whisper Pay is wallet-only and never touches note internals or
 * the viewing key, so that claim is not ours to make.
 *
 * Two limits are built into the format itself, not just written in the docs:
 *
 *   1. **It cannot name the payer.** The pool hides the sender from everyone,
 *      the recipient included. A receipt can say "request X was paid"; it can
 *      never say who paid it, and no field here carries a payer.
 *
 *   2. **The amount is deliberately absent.** A receipt that stated the amount
 *      would publish the one number the pool exists to hide, to everyone the
 *      recipient ever shows it to. So the signed payload has no amount field,
 *      and a verifier is told plainly that it never did.
 *
 * And a limit no format can fix: this is for cooperative use — showing an
 * accountant or a client that a request was fulfilled. It is useless in an
 * adversarial dispute, because the recipient is the party being disputed and
 * simply won't sign a receipt that hurts their case.
 */

/** The one claim a receipt can make. Fixed, so nobody signs a bespoke sentence. */
export const RECEIPT_CLAIM = "Request paid in full";

/** Bumped only if the signed payload's shape changes. */
export const RECEIPT_VERSION = 1;

export interface Receipt {
  version: number;
  /** Request id — or `<id>.<n>` for one installment of a recurring request. */
  request: string;
  /** Always `RECEIPT_CLAIM`. Present so the artifact reads as what it is. */
  claim: string;
  /** Unix seconds, as signed. When the recipient issued this, not when paid. */
  issuedAt: number;
  /**
   * The account that signed. Needed to check the signature against its contract
   * — so sharing a receipt discloses the recipient's own address, and still
   * discloses nothing whatsoever about the payer.
   */
  recipient: string;
  /** Whatever the wallet returned; shape varies by account implementation. */
  signature: string[];
}

/**
 * The message a recipient signs. SNIP-12 revision 1.
 *
 * Note what isn't here: no amount, no token, no payer, no transaction hash. A
 * verifier can therefore never mistake this for evidence of any of them, which
 * is worth more than the convenience of including them.
 *
 * `shortstring` caps at 31 characters — request ids are 12, plus at most 4 for
 * an installment suffix, and the claim is fixed at 20.
 */
export function receiptTypedData(request: string, issuedAt: number): TypedData {
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
      Receipt: [
        { name: "claim", type: "shortstring" },
        { name: "request", type: "shortstring" },
        { name: "issuedAt", type: "timestamp" },
      ],
    },
    primaryType: "Receipt",
    message: {
      claim: RECEIPT_CLAIM,
      request,
      issuedAt,
    },
  };
}

/**
 * Read an artifact somebody handed us.
 *
 * Every field is attacker-controlled — a receipt is meant to be passed around —
 * so this refuses anything it doesn't fully understand rather than verifying a
 * half-parsed object. In particular the claim must match exactly: a receipt
 * asserting some other sentence is not a receipt this app can vouch for.
 */
export function parseReceipt(value: unknown): Receipt | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<Receipt>;

  if (candidate.version !== RECEIPT_VERSION) return null;
  if (candidate.claim !== RECEIPT_CLAIM) return null;
  if (typeof candidate.request !== "string") return null;
  if (!/^[A-Za-z0-9_-]{1,32}(?:\.\d{1,3})?$/.test(candidate.request)) return null;
  if (typeof candidate.issuedAt !== "number" || !Number.isFinite(candidate.issuedAt)) {
    return null;
  }
  if (candidate.issuedAt <= 0 || !Number.isInteger(candidate.issuedAt)) return null;
  if (typeof candidate.recipient !== "string" || !isValidAddress(candidate.recipient)) {
    return null;
  }
  if (
    !Array.isArray(candidate.signature) ||
    candidate.signature.length === 0 ||
    !candidate.signature.every((part) => typeof part === "string")
  ) {
    return null;
  }

  return {
    version: candidate.version,
    request: candidate.request,
    claim: candidate.claim,
    issuedAt: candidate.issuedAt,
    recipient: candidate.recipient,
    signature: candidate.signature,
  };
}

/**
 * A wallet's signature, reduced to the felts a receipt carries.
 *
 * Accounts answer `signMessage` differently: most return an array of felts, the
 * plain Stark-curve path returns an `{ r, s }` pair. Anything else is not a
 * signature this app can put its name to.
 *
 * `null` rather than an empty array for those, and the distinction matters: an
 * empty array reads as a signature right up until `parseReceipt` refuses it,
 * which happens on the verifier's screen — long after the recipient handed the
 * file over believing it was good. A receipt that cannot be checked has to fail
 * while the person who can do something about it is still looking.
 */
export function signatureParts(signature: unknown): string[] | null {
  if (Array.isArray(signature)) {
    const parts = signature.map((part) => String(part));
    return parts.length > 0 ? parts : null;
  }

  if (typeof signature === "object" && signature !== null) {
    const { r, s } = signature as { r?: unknown; s?: unknown };
    if (r !== undefined && s !== undefined) {
      try {
        return [r, s].map((value) => `0x${BigInt(String(value)).toString(16)}`);
      } catch {
        // r/s that aren't numeric — not a Stark signature, whatever it is.
        return null;
      }
    }
  }

  return null;
}

/** Pretty JSON, which is what gets downloaded — receipts get read by people. */
export function receiptToJson(receipt: Receipt): string {
  return `${JSON.stringify(receipt, null, 2)}\n`;
}

/**
 * A receipt as a link. Same trick as a payment link: the whole thing rides in
 * the URL, so verifying needs no lookup and no server holding a copy.
 */
export function encodeReceipt(receipt: Receipt): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(receipt)));
}

export function decodeReceipt(encoded: string): Receipt | null {
  try {
    const json = new TextDecoder().decode(base64UrlToBytes(encoded));
    return parseReceipt(JSON.parse(json));
  } catch {
    return null;
  }
}

export function verifyPath(receipt: Receipt): string {
  return `/verify-receipt?r=${encodeReceipt(receipt)}`;
}
