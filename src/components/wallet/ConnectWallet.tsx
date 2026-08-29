"use client";

import { useState, useSyncExternalStore } from "react";
import { createStore, type Store } from "@starknet-io/get-starknet-discovery";
import type { WalletWithStarknetFeatures } from "@starknet-io/get-starknet-wallet-standard/features";

import { buttonClass } from "@/components/ui/Button";
import { PRIVACY_WALLETS } from "@/lib/strk20/constants";
import { useWallet } from "./walletStore";

/**
 * Wallet discovery is a genuine external store: wallets register themselves
 * asynchronously after page load, and the set is global rather than per
 * component. Reading it through `useSyncExternalStore` keeps the snapshot
 * reference stable between changes — a `useEffect` + `useState` pair would
 * re-slice the array on every notification and re-render regardless.
 */
const EMPTY: readonly WalletWithStarknetFeatures[] = [];

let discoveryStore: Store | undefined;
let snapshot: readonly WalletWithStarknetFeatures[] = EMPTY;

function subscribeToWallets(onStoreChange: () => void): () => void {
  // Created on first subscribe — which React runs in an effect, so this never
  // happens during render — and kept for the lifetime of the page.
  discoveryStore ??= createStore({ eip1193Adapters: [] });
  snapshot = discoveryStore.getWallets().slice();
  onStoreChange();

  return discoveryStore.subscribe((next) => {
    snapshot = next.slice();
    onStoreChange();
  });
}

function getWalletsSnapshot(): readonly WalletWithStarknetFeatures[] {
  return snapshot;
}

function getServerSnapshot(): readonly WalletWithStarknetFeatures[] {
  return EMPTY;
}

/**
 * Wallet discovery and connection.
 *
 * Uses `get-starknet` discovery directly rather than starknetkit's `connect()`:
 * that path bundles MetaMask detection which repeatedly probes the MetaMask
 * Starknet Snap and spams its unlock prompt. `eip1193Adapters: []` keeps
 * MetaMask out of discovery entirely, so only the wallet the user picks is ever
 * contacted.
 */
export default function ConnectWallet({
  variant = "primary",
}: {
  variant?: "primary" | "compact";
}) {
  const { isConnected, isConnecting, address, connect, disconnect } = useWallet();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState("");

  const wallets = useSyncExternalStore(
    subscribeToWallets,
    getWalletsSnapshot,
    getServerSnapshot
  );

  const pickable = wallets.filter(
    (w) => !w.name.toLowerCase().replace(/[^a-z]/g, "").includes("metamask")
  );

  async function pick(wallet: WalletWithStarknetFeatures) {
    setError("");
    try {
      await connect(wallet);
      setPickerOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Wallet connection failed.");
    }
  }

  const short = address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";

  const picker = pickerOpen ? (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={() => !isConnecting && setPickerOpen(false)}
    >
      <div
        className="w-full max-w-sm border-2 border-hairline bg-surface p-5 shadow-hard"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="display text-sm">Connect a wallet</h2>
          <button
            type="button"
            aria-label="Close"
            disabled={isConnecting}
            onClick={() => setPickerOpen(false)}
            className="px-2 text-lg leading-none text-muted transition-colors hover:text-foreground disabled:opacity-40"
          >
            ×
          </button>
        </div>

        {pickable.length > 0 ? (
          <ul className="space-y-2">
            {pickable.map((wallet) => (
              <li key={wallet.name}>
                <button
                  type="button"
                  disabled={isConnecting}
                  onClick={() => pick(wallet)}
                  className="pixel-press flex w-full items-center gap-3 border-2 border-hairline bg-background px-3 py-3 text-left hover:border-accent disabled:opacity-50"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={wallet.icon} alt="" className="pixelated size-7" />
                  <span className="flex-1 text-sm font-medium">{wallet.name}</span>
                  <span className="text-muted">{isConnecting ? "…" : "→"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm leading-relaxed text-muted">
            No Starknet wallet detected. Whisper Pay needs one with STRK20
            support —{" "}
            {PRIVACY_WALLETS.map((wallet, index) => (
              <span key={wallet.name}>
                {index > 0 ? " and " : ""}
                <a
                  href={wallet.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline underline-offset-4"
                >
                  {wallet.name}
                </a>
              </span>
            ))}{" "}
            support it today.
          </p>
        )}

        {error ? (
          <p className="mt-3 text-xs leading-relaxed text-danger">{error}</p>
        ) : null}
      </div>
    </div>
  ) : null;

  if (isConnected && address) {
    return (
      <button
        type="button"
        onClick={disconnect}
        title="Disconnect"
        className="pixel-press group inline-flex items-center gap-2 border-2 border-hairline bg-background px-3 py-1.5 font-mono text-xs hover:border-accent"
      >
        <span className="size-1.5 bg-ok" />
        {short}
        <span className="text-muted transition-colors group-hover:text-foreground">
          Disconnect
        </span>
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setError("");
          setPickerOpen(true);
        }}
        className={
          variant === "primary"
            ? `${buttonClass("primary", "lg")} w-full`
            : buttonClass("secondary", "sm")
        }
      >
        Connect wallet
      </button>
      {picker}
    </>
  );
}
