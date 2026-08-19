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

/**
 * Wallets that implement the STRK20 privacy API.
 *
 * Registering a viewing key and shielding both happen *inside the wallet* —
 * that's where the viewing key lives, and no dapp can do it on the user's
 * behalf. So when a user isn't registered yet, the right instruction is "open
 * your wallet", not a link to some other web app.
 */
export const PRIVACY_WALLETS = [
  { name: "Ready", url: "https://www.ready.co/" },
  { name: "Xverse", url: "https://www.xverse.app/" },
] as const;

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

/** Look up a token by address, padded or not. */
export function findToken(address: string): TokenInfo | undefined {
  return Object.values(TOKENS).find((token) =>
    sameAddress(token.address, address)
  );
}

/**
 * The app's canonical form for a Starknet address: lowercase hex, leading zeros
 * in the body stripped.
 *
 * Starknet addresses are field elements, so the same account arrives spelled
 * differently depending on where the value came from — `validateAndParseAddress`
 * and most wallets pad to 64 hex digits, a link or an event log usually
 * doesn't. `0x0116…be41` and `0x116…be41` are one account.
 *
 * Everything the app stores, compares or displays goes through here, including
 * addresses arriving from a wallet — see `walletStore`. One form throughout is
 * what keeps a padded copy from ever being held up against an unpadded one.
 */
export function normalizeAddress(address: string): string {
  const hex = address.trim().toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
  return `0x${hex || "0"}`;
}

/**
 * Whether two addresses are the same account.
 *
 * Compares the numbers, not the strings, so no amount of padding, casing or
 * whitespace can make one account look like two. Anything unparseable is not
 * equal to anything, including itself — a malformed address is not a match, and
 * silently treating it as one is how a signing gate lets the wrong key through.
 *
 * Use this rather than `===` on any two addresses, even normalized ones. The
 * name says what the comparison means; `===` on strings only says they were
 * spelled alike.
 */
export function sameAddress(a: string, b: string): boolean {
  // Both sides are validated first, and not only to avoid a throw: `BigInt("")`
  // is `0n`, so a bare numeric comparison quietly rules that two blank
  // addresses are the same account — which is what a signing gate sees when no
  // wallet is connected at all.
  if (!isValidAddress(a) || !isValidAddress(b)) return false;
  return BigInt(a.trim()) === BigInt(b.trim());
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
