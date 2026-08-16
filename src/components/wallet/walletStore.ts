"use client";

import { create } from "zustand";
import {
  WalletAccountV6,
  walletV6,
  validateAndParseAddress,
} from "starknet";
import type { WalletWithStarknetFeatures } from "@starknet-io/get-starknet-wallet-standard/features";

import { MAINNET_CHAIN_ID, normalizeAddress } from "@/lib/strk20/constants";
import { mainnetProvider } from "@/lib/strk20/provider";
import { describeStrk20Error } from "@/lib/strk20/errors";

/**
 * Whether this wallet + account can actually move money through the pool.
 *
 * Determined by *trying* a `strk20Balances` read rather than by sniffing
 * version strings — the failure modes we care about (wallet has no STRK20
 * support, user never registered a viewing key) are exactly the errors that
 * call returns.
 */
export type PoolStatus =
  | "unknown"
  | "ready"
  | "not-registered"
  | "unsupported";

export interface WalletState {
  wallet?: WalletWithStarknetFeatures;
  account?: WalletAccountV6;
  address: string;
  chainId: string;
  isConnected: boolean;
  isConnecting: boolean;
  connectError?: string;

  poolStatus: PoolStatus;
  /** Shielded balances by normalized token address. Undefined until read. */
  balances?: Record<string, bigint>;
  balancesLoading: boolean;
  balancesError?: string;

  connect: (wallet: WalletWithStarknetFeatures) => Promise<void>;
  disconnect: () => void;
  switchToMainnet: () => Promise<void>;
  /** Reads shielded balances and, as a side effect, settles `poolStatus`. */
  refreshBalances: () => Promise<void>;
}

/** Unsubscribe handle for the connected wallet's change events. */
let unsubscribe: (() => void) | undefined;

export const useWallet = create<WalletState>()((set, get) => ({
  address: "",
  chainId: "",
  isConnected: false,
  isConnecting: false,
  poolStatus: "unknown",
  balancesLoading: false,

  async connect(wallet) {
    set({ isConnecting: true, connectError: undefined });
    try {
      const account = await WalletAccountV6.connect(mainnetProvider, wallet);

      const accounts = await walletV6.requestAccounts(wallet);
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error("Wallet returned no accounts.");
      }
      const address = validateAndParseAddress(accounts[0]);
      const chainId = (await walletV6.requestChainId(wallet)) as string;

      unsubscribe?.();
      unsubscribe = walletV6.subscribeWalletEvent(wallet, () => {
        // The change payload's shape varies by wallet; re-read the two things
        // we actually depend on instead of parsing it.
        void (async () => {
          try {
            const [nextAccounts, nextChain] = await Promise.all([
              walletV6.requestAccounts(wallet),
              walletV6.requestChainId(wallet),
            ]);
            const nextAddress = Array.isArray(nextAccounts) && nextAccounts[0]
              ? validateAndParseAddress(nextAccounts[0])
              : "";
            set({
              address: nextAddress,
              chainId: nextChain as string,
              isConnected: Boolean(nextAddress),
              // Both are account- and network-scoped; force a re-read.
              balances: undefined,
              poolStatus: "unknown",
            });
          } catch {
            /* a wallet that can't answer is a wallet we've lost — leave state */
          }
        })();
      });

      set({
        wallet,
        account,
        address,
        chainId,
        isConnected: true,
        isConnecting: false,
        balances: undefined,
        poolStatus: "unknown",
      });
    } catch (error) {
      set({
        isConnecting: false,
        connectError:
          error instanceof Error ? error.message : "Wallet connection failed.",
      });
      throw error;
    }
  },

  disconnect() {
    unsubscribe?.();
    unsubscribe = undefined;
    set({
      wallet: undefined,
      account: undefined,
      address: "",
      chainId: "",
      isConnected: false,
      poolStatus: "unknown",
      balances: undefined,
      balancesError: undefined,
      connectError: undefined,
    });
  },

  async switchToMainnet() {
    const { account } = get();
    if (!account) return;
    await account.switchStarknetChain(MAINNET_CHAIN_ID as never);
    const { wallet } = get();
    if (wallet) {
      set({ chainId: (await walletV6.requestChainId(wallet)) as string });
    }
  },

  async refreshBalances() {
    const { account } = get();
    if (!account) return;

    set({ balancesLoading: true, balancesError: undefined });
    try {
      const entries = await account.strk20Balances([]);
      const balances: Record<string, bigint> = {};
      for (const entry of entries) {
        balances[normalizeAddress(entry.token)] = BigInt(entry.balance);
      }
      set({ balances, poolStatus: "ready", balancesLoading: false });
    } catch (error) {
      const failure = describeStrk20Error(error);
      const poolStatus: PoolStatus =
        failure.kind === "not-registered"
          ? "not-registered"
          : failure.kind === "unsupported-wallet" ||
              /not supported|unknown method|method not found/i.test(
                failure.raw ?? ""
              )
            ? "unsupported"
            : "unknown";

      set({
        poolStatus,
        balancesLoading: false,
        // "Not registered" and "unsupported" are states the UI explains on its
        // own; only surface a message for genuine failures.
        balancesError: poolStatus === "unknown" ? failure.detail : undefined,
      });
    }
  },
}));

/** Convenience selector — the app refuses to build actions off mainnet. */
export function useOnMainnet(): boolean {
  return useWallet(
    (state) => state.isConnected && state.chainId === MAINNET_CHAIN_ID
  );
}

/** Shielded balance for one token, or 0n when balances haven't been read. */
export function useShieldedBalance(tokenAddress: string): bigint {
  return useWallet(
    (state) => state.balances?.[normalizeAddress(tokenAddress)] ?? 0n
  );
}
