"use client";

import { useState } from "react";

import ConnectWallet from "@/components/wallet/ConnectWallet";
import { useWallet } from "@/components/wallet/walletStore";
import { revealTypedData } from "@/lib/request/proof";
import { VOYAGER_TX_URL } from "@/lib/strk20/constants";

/**
 * Showing the recipient the transaction behind their payment.
 *
 * The hash is the one thing here that can lead somewhere: for a payer who
 * shielded to pay, it points at a public deposit carrying their address and the
 * amount. So it isn't on the page — it's released by the API only against a
 * signature from the address the request was addressed to.
 *
 * Signing costs nothing and sends no transaction; the wallet is being asked to
 * prove who it is, not to move money. The message says as much, in words the
 * wallet displays.
 */
export default function RevealProof({ statusId }: { statusId: string }) {
  const { account, address, isConnected } = useWallet();
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reveal() {
    if (!account) return;
    setBusy(true);
    setError(null);

    try {
      const signature = await account.signMessage(revealTypedData(statusId));

      const response = await fetch(`/api/status/${statusId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reveal", address, signature }),
      });
      const body = await response.json();

      if (!response.ok) {
        setError(body.error ?? "The proof couldn't be released.");
        return;
      }
      setTxHash(body.txHash as string);
    } catch {
      // Declining the signature lands here too, which needs no explaining.
      setError(null);
    } finally {
      setBusy(false);
    }
  }

  if (txHash) {
    return (
      <div className="mt-5 border-t border-hairline pt-4">
        <p className="text-xs font-medium">The transaction that paid this</p>
        <a
          href={`${VOYAGER_TX_URL}${txHash}`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block rounded-xl border border-hairline px-3 py-2 font-mono text-xs transition hover:bg-surface-raised"
        >
          {txHash.slice(0, 12)}…{txHash.slice(-8)} ↗
        </a>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          Yours to check, and deliberately not on the public version of this
          page: for a payer who shielded first, this hash leads to a public
          deposit with their address on it.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-5 border-t border-hairline pt-4">
      <p className="text-xs font-medium">Are you the recipient?</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">
        Prove it with a signature and you can see the transaction behind this
        payment. Signing sends nothing and costs nothing.
      </p>

      {!isConnected ? (
        <div className="mt-3">
          <ConnectWallet />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => void reveal()}
          disabled={busy}
          className="mt-3 rounded-xl border border-hairline px-4 py-2 text-xs transition hover:bg-surface-raised disabled:opacity-50"
        >
          {busy ? "Waiting for your wallet…" : "Show me the transaction"}
        </button>
      )}

      {error ? (
        <p className="mt-3 text-xs leading-relaxed text-amber-200/80">{error}</p>
      ) : null}
    </div>
  );
}
