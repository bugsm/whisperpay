"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import ConnectWallet from "@/components/wallet/ConnectWallet";
import { useWallet, type WalletState } from "@/components/wallet/walletStore";
import { AmountError, formatDisplay, parseUnits } from "@/lib/amount";
import {
  loadHistory,
  removeFromHistory,
  type HistoryEntry,
} from "@/lib/request/history";
import type { RequestStatus } from "@/lib/request/types";
import {
  DEFAULT_TOKEN,
  MAINNET_CHAIN_ID,
  POOL_APP_URL,
  VOYAGER_TX_URL,
  normalizeAddress,
} from "@/lib/strk20/constants";
import { describeStrk20Error } from "@/lib/strk20/errors";
import { planUnshield } from "@/lib/strk20/plan";
import { mainnetProvider } from "@/lib/strk20/provider";

export default function Dashboard() {
  const {
    account,
    address,
    chainId,
    isConnected,
    poolStatus,
    balances,
    balancesLoading,
    refreshBalances,
    switchToMainnet,
  } = useWallet();

  const onMainnet = isConnected && chainId === MAINNET_CHAIN_ID;

  useEffect(() => {
    if (onMainnet && balances === undefined && !balancesLoading) {
      void refreshBalances();
    }
  }, [onMainnet, balances, balancesLoading, refreshBalances]);

  const balance = balances?.[normalizeAddress(DEFAULT_TOKEN.address)] ?? 0n;

  // The balance half needs a connected, registered, mainnet wallet. The links
  // half doesn't — it's local history, and gating it behind a wallet would hide
  // a user's own invoices from them for no reason.
  let balanceSection: React.ReactNode;

  if (!isConnected) {
    balanceSection = (
      <Panel title="Your private balance">
        <p className="mb-4 text-sm text-muted">
          Connect the wallet you receive payments with. Balances are read from
          your wallet using your own viewing key — Whisper Pay never holds it.
        </p>
        <ConnectWallet />
      </Panel>
    );
  } else if (!onMainnet) {
    balanceSection = (
      <Panel title="Switch to mainnet">
        <p className="mb-4 text-sm text-muted">
          The STRK20 pool this app talks to lives on Starknet mainnet.
        </p>
        <button
          type="button"
          onClick={() => void switchToMainnet()}
          className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-[#14101f] transition hover:brightness-110"
        >
          Switch network
        </button>
      </Panel>
    );
  } else if (poolStatus === "not-registered") {
    balanceSection = (
      <Panel title="Register with the privacy pool">
        <p className="mb-4 text-sm leading-relaxed text-muted">
          You publish a viewing key on-chain once. Until then nothing can be sent
          to you privately, so payment links pointing at this address won't work.
        </p>
        <a
          href={POOL_APP_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-block rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-[#14101f] transition hover:brightness-110"
        >
          Register ↗
        </a>
      </Panel>
    );
  } else if (poolStatus === "unsupported") {
    balanceSection = (
      <Panel title="This wallet doesn't support STRK20">
        <p className="text-sm text-muted">
          Reading a shielded balance needs the STRK20 wallet API.{" "}
          <a
            href="https://www.ready.co/"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline underline-offset-4"
          >
            Ready
          </a>{" "}
          supports it today.
        </p>
      </Panel>
    );
  } else {
    balanceSection = (
      <>
        <BalanceCard
          balance={balance}
          loading={balancesLoading}
          onRefresh={() => void refreshBalances()}
        />
        <WithdrawCard
          account={account}
          address={address}
          balance={balance}
          onDone={() => void refreshBalances()}
        />
      </>
    );
  }

  return (
    <div className="space-y-5">
      {balanceSection}
      <RequestList />
    </div>
  );
}

function BalanceCard({
  balance,
  loading,
  onRefresh,
}: {
  balance: bigint;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium tracking-wide text-muted uppercase">
            Shielded balance
          </p>
          <p className="tabular mt-2 text-4xl font-semibold">
            {loading ? "—" : formatDisplay(balance, DEFAULT_TOKEN.decimals)}{" "}
            <span className="text-xl text-muted">{DEFAULT_TOKEN.symbol}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="rounded-lg border border-hairline px-3 py-1.5 text-xs transition hover:bg-surface-raised disabled:opacity-50"
        >
          {loading ? "Reading…" : "Refresh"}
        </button>
      </div>
      <p className="mt-4 border-t border-hairline pt-4 text-xs leading-relaxed text-muted">
        This is the sum of your unspent notes inside the pool. Incoming private
        transfers land here with no public trace of who sent them or how much.
      </p>
    </section>
  );
}

function WithdrawCard({
  account,
  address,
  balance,
  onDone,
}: {
  account: WalletState["account"];
  address: string;
  balance: bigint;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [destination, setDestination] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [txHash, setTxHash] = useState("");

  async function withdraw(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    setTxHash("");
    if (!account) return;

    let raw: bigint;
    try {
      raw = parseUnits(amount, DEFAULT_TOKEN.decimals);
    } catch (err) {
      setError(err instanceof AmountError ? err.message : "Invalid amount.");
      return;
    }
    if (raw <= 0n) {
      setError("Enter an amount greater than zero.");
      return;
    }
    if (raw > balance) {
      setError("That's more than your shielded balance.");
      return;
    }

    setBusy(true);
    try {
      const actions = planUnshield(
        DEFAULT_TOKEN.address,
        raw,
        destination || address
      );
      const { transaction_hash } = await account.strk20InvokeTransaction(actions);
      setTxHash(transaction_hash);
      try {
        await mainnetProvider.waitForTransaction(transaction_hash, {
          retries: 400,
          retryInterval: 3000,
        });
      } catch {
        /* may still land; we just stopped watching */
      }
      setAmount("");
      onDone();
    } catch (err) {
      setError(describeStrk20Error(err).detail);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={withdraw}
      className="rounded-2xl border border-hairline bg-surface p-6"
    >
      <h2 className="text-sm font-semibold">Withdraw to spend</h2>
      <p className="mt-1 text-sm text-muted">
        Move funds out of the pool to a public address.
      </p>

      <div className="mt-4 space-y-3">
        <div className="flex items-center gap-2 rounded-xl border border-hairline bg-background px-3 py-2.5 focus-within:border-accent">
          <input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            inputMode="decimal"
            placeholder="0.0"
            className="tabular min-w-0 flex-1 bg-transparent text-lg outline-none"
          />
          <button
            type="button"
            onClick={() =>
              setAmount(formatDisplay(balance, DEFAULT_TOKEN.decimals, 18))
            }
            className="shrink-0 text-xs text-accent"
          >
            Max
          </button>
          <span className="shrink-0 rounded-lg bg-surface-raised px-2.5 py-1 text-xs">
            {DEFAULT_TOKEN.symbol}
          </span>
        </div>

        <input
          value={destination}
          onChange={(event) => setDestination(event.target.value.trim())}
          placeholder={`Destination — defaults to ${address.slice(0, 6)}…${address.slice(-4)}`}
          spellCheck={false}
          className="w-full rounded-xl border border-hairline bg-background px-3 py-2.5 font-mono text-xs outline-none transition focus:border-accent"
        />
      </div>

      <p className="mt-3 rounded-lg bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-200/80">
        Withdrawals are public: the destination address and the amount are
        visible on-chain. What stays hidden is which deposit the money came from.
      </p>

      {error ? <p className="mt-3 text-xs text-red-400">{error}</p> : null}

      {txHash ? (
        <a
          href={`${VOYAGER_TX_URL}${txHash}`}
          target="_blank"
          rel="noreferrer"
          className="mt-3 block font-mono text-xs text-accent underline underline-offset-4"
        >
          {txHash.slice(0, 12)}…{txHash.slice(-6)} ↗
        </a>
      ) : null}

      <button
        type="submit"
        disabled={busy || balance === 0n}
        className="mt-4 w-full rounded-xl border border-hairline px-4 py-2.5 text-sm font-medium transition hover:bg-surface-raised disabled:opacity-50"
      >
        {busy ? "Withdrawing…" : "Withdraw"}
      </button>
    </form>
  );
}

function RequestList() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [statuses, setStatuses] = useState<Record<string, RequestStatus>>({});

  useEffect(() => {
    setEntries(loadHistory());
  }, []);

  const refreshStatuses = useCallback(async (list: HistoryEntry[]) => {
    const results = await Promise.all(
      list.map(async (entry) => {
        try {
          const response = await fetch(`/api/status/${entry.id}`);
          if (!response.ok) return [entry.id, "pending" as RequestStatus] as const;
          const body = await response.json();
          return [entry.id, body.record.status as RequestStatus] as const;
        } catch {
          return [entry.id, "pending" as RequestStatus] as const;
        }
      })
    );
    setStatuses(Object.fromEntries(results));
  }, []);

  useEffect(() => {
    if (entries.length > 0) void refreshStatuses(entries);
  }, [entries, refreshStatuses]);

  async function confirm(id: string) {
    try {
      await fetch(`/api/status/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm" }),
      });
      setStatuses((prev) => ({ ...prev, [id]: "confirmed" }));
    } catch {
      /* leave the badge as it was */
    }
  }

  if (entries.length === 0) {
    return (
      <section className="rounded-2xl border border-hairline bg-surface p-6">
        <h2 className="text-sm font-semibold">Your payment links</h2>
        <p className="mt-1 text-sm text-muted">
          Links you create appear here.{" "}
          <Link href="/" className="text-accent underline underline-offset-4">
            Create one
          </Link>
          .
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-hairline bg-surface p-6">
      <h2 className="text-sm font-semibold">Your payment links</h2>
      <p className="mt-1 text-xs text-muted">
        Kept in this browser only — Whisper Pay never stores a list of who you
        billed.
      </p>

      <ul className="mt-4 divide-y divide-[var(--hairline)]">
        {entries.map((entry) => {
          const status = statuses[entry.id] ?? "pending";
          return (
            <li key={entry.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="tabular text-sm font-medium">
                  {formatDisplay(BigInt(entry.amount), DEFAULT_TOKEN.decimals)}{" "}
                  {DEFAULT_TOKEN.symbol}
                  {entry.memo ? (
                    <span className="ml-2 font-normal text-muted">{entry.memo}</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {new Date(entry.createdAt * 1000).toLocaleDateString()}
                </p>
              </div>

              <StatusBadge status={status} />

              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  title="Copy link"
                  onClick={() => void navigator.clipboard.writeText(entry.url)}
                  className="rounded-lg border border-hairline px-2 py-1 text-xs transition hover:bg-surface-raised"
                >
                  Copy
                </button>
                {status === "submitted" ? (
                  <button
                    type="button"
                    title="Mark as received"
                    onClick={() => void confirm(entry.id)}
                    className="rounded-lg border border-emerald-400/40 px-2 py-1 text-xs text-emerald-300 transition hover:bg-emerald-400/10"
                  >
                    Confirm
                  </button>
                ) : null}
                <button
                  type="button"
                  title="Remove from this browser"
                  onClick={() => {
                    removeFromHistory(entry.id);
                    setEntries(loadHistory());
                  }}
                  className="rounded-lg border border-hairline px-2 py-1 text-xs text-muted transition hover:bg-surface-raised"
                >
                  ×
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 border-t border-hairline pt-4 text-xs leading-relaxed text-muted">
        <strong className="font-medium text-foreground">Why two steps:</strong> a
        payer's transaction can be verified as a real, successful pool
        transaction — but not as payment of <em>this</em> request, because the
        transfer hides its amount and parties. Check your shielded balance above,
        then confirm.
      </p>
    </section>
  );
}

function StatusBadge({ status }: { status: RequestStatus }) {
  const style: Record<RequestStatus, string> = {
    pending: "border-hairline text-muted",
    submitted: "border-amber-400/40 text-amber-300",
    confirmed: "border-emerald-400/40 text-emerald-300",
    expired: "border-hairline text-muted line-through",
  };
  const label: Record<RequestStatus, string> = {
    pending: "Unpaid",
    submitted: "Submitted",
    confirmed: "Received",
    expired: "Expired",
  };
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs ${style[status]}`}
    >
      {label[status]}
    </span>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-6">
      <h1 className="mb-1 text-lg font-semibold">{title}</h1>
      {children}
    </section>
  );
}
