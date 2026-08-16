/**
 * Starknet ID resolution — paying `alice.stark` instead of `0x04718f5a…`.
 *
 * Resolution runs on-chain against the official naming contract through our own
 * RPC provider. There is a public HTTP resolver, but using it would tell a third
 * party which names a payer is looking up, which is the opposite of the point.
 *
 * A name is only ever a *label*. What gets paid is the address, resolved once
 * when the link is created and carried in the link itself — see
 * `verifyNameStillResolves` for why that matters.
 */

import { CallData } from "starknet";

import { mainnetProvider } from "@/lib/strk20/provider";
import { normalizeAddress } from "@/lib/strk20/constants";
import { decodeDomain, encodeDomain, isStarkDomain } from "./encoding";

export { isStarkDomain, MAX_NAME_LENGTH } from "./encoding";

/**
 * Starknet ID naming contract, Starknet mainnet.
 * https://docs.starknet.id/architecture/naming
 */
export const NAMING_CONTRACT =
  "0x6ac597f8116f886fa1c97a23fa4e08299975ecaf6b598873ca6792b9bbfb678";

const ZERO = BigInt(0);

/**
 * `alice.stark` → owner address, or null when the name isn't registered.
 *
 * A name resolving to address zero counts as unregistered — that's what the
 * contract reports for an unclaimed or expired domain.
 */
export async function resolveStarkName(domain: string): Promise<string | null> {
  const name = domain.trim().toLowerCase();
  if (!isStarkDomain(name)) return null;

  try {
    const result = await mainnetProvider.callContract({
      contractAddress: NAMING_CONTRACT,
      entrypoint: "domain_to_address",
      calldata: CallData.compile({
        domain: encodeDomain(name).map((felt) => felt.toString()),
        hint: [],
      }),
    });
    const address = result?.[0];
    if (!address || BigInt(address) === ZERO) return null;
    return normalizeAddress(address);
  } catch {
    // Unregistered names make the contract revert rather than return zero.
    return null;
  }
}

/** Address → its primary `.stark` name, or null when none is set. */
export async function lookupStarkName(address: string): Promise<string | null> {
  try {
    const result = await mainnetProvider.callContract({
      contractAddress: NAMING_CONTRACT,
      entrypoint: "address_to_domain",
      calldata: CallData.compile({ address, hint: [] }),
    });
    // First element is the array length; the rest are the encoded labels.
    const domain = decodeDomain(result.slice(1).map((felt) => BigInt(felt)));
    return domain || null;
  } catch {
    return null;
  }
}

export type NameCheck =
  | { state: "match"; name: string; address: string }
  | { state: "moved"; name: string; expected: string; actual: string | null }
  | { state: "unchecked"; name: string };

/**
 * Confirm a link's name label still points at the address baked into the link.
 *
 * Names are transferable and re-pointable. If a link said "pay alice.stark" and
 * carried alice's address, and alice later sells the name, a payer opening that
 * old link must not be shown a name that now belongs to someone else. The
 * address in the link stays authoritative — this check exists so the UI can say
 * plainly when the label has drifted away from it.
 *
 * Network failures return `unchecked` rather than a false alarm: an RPC hiccup
 * is not evidence that a name moved.
 */
export async function verifyNameStillResolves(
  name: string,
  expectedAddress: string
): Promise<NameCheck> {
  let actual: string | null;
  try {
    actual = await resolveStarkName(name);
  } catch {
    return { state: "unchecked", name };
  }

  if (actual && normalizeAddress(actual) === normalizeAddress(expectedAddress)) {
    return { state: "match", name, address: normalizeAddress(expectedAddress) };
  }
  return {
    state: "moved",
    name,
    expected: normalizeAddress(expectedAddress),
    actual,
  };
}
