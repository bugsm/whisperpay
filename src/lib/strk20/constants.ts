/**
 * STRK20 mainnet configuration.
 *
 * Whisper Pay is mainnet-only by design — the sprint requires it, and the
 * privacy pool's mainnet deployment is the only one these values point at.
 * Sourced from the sprint's Day 0 guide (docs/MAINNET-DAY-0.md in
 * starkience/strk20-hackathon), which lists them as verified against the live
 * network.
 */

/** `SN_MAIN`. The app refuses to build STRK20 actions on any other chain. */
export const MAINNET_CHAIN_ID = "0x534e5f4d41494e";

/** The STRK20 privacy pool on Starknet mainnet. */
export const POOL_ADDRESS =
  "0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a";

/** Public mainnet RPC. Override with a dedicated endpoint for production. */
export const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL ?? "https://rpc.starknet.lava.build";

export const VOYAGER_TX_URL = "https://voyager.online/tx/";
export const VOYAGER_CONTRACT_URL = "https://voyager.online/contract/";

/** Where a user registers their viewing key if they haven't yet. */
export const POOL_APP_URL = "https://strk20.starknet.io/app";

export interface TokenInfo {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  /**
   * Suggested rounding step for the optional "round up the deposit" privacy
   * control — see `planPayment`. Chosen so a rounded deposit lands on a common
   * value rather than a distinctive one.
   */
  shieldRoundingStep: bigint;
}

export const STRK: TokenInfo = {
  symbol: "STRK",
  name: "Starknet Token",
  address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
  decimals: 18,
  shieldRoundingStep: 10n * 10n ** 18n,
};

/**
 * Tokens a payment request may be denominated in. STRK only for now — every
 * entry here needs its own mainnet test against the live pool before it ships.
 */
export const TOKENS: Record<string, TokenInfo> = {
  [STRK.address]: STRK,
};

export const DEFAULT_TOKEN = STRK;

/** Look up a token by address, tolerating unpadded hex. */
export function findToken(address: string): TokenInfo | undefined {
  const target = normalizeAddress(address);
  return Object.values(TOKENS).find((t) => normalizeAddress(t.address) === target);
}

/**
 * Canonical lowercase hex form of a Starknet address, with leading zeros in the
 * body stripped. Used for comparisons only — never for display or calldata.
 */
export function normalizeAddress(address: string): string {
  const hex = address.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
  return `0x${hex || "0"}`;
}

/**
 * A Starknet address is a field element: at most 63 hex digits (the field
 * modulus is just under 2^252), and never zero.
 */
export function isValidAddress(address: string): boolean {
  const value = address.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) return false;
  try {
    const n = BigInt(value);
    return n > 0n && n < 2n ** 252n;
  } catch {
    return false;
  }
}
