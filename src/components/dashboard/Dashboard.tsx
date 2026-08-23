"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import ConnectWallet from "@/components/wallet/ConnectWallet";
import { useWallet, type WalletState } from "@/components/wallet/walletStore";
import { AmountError, formatDisplay, parseUnits } from "@/lib/amount";
import { statusPath } from "@/lib/request/codec";
import {
  loadHistory,
  removeFromHistory,
  type HistoryEntry,
} from "@/lib/request/history";
import {
  currentInstallment,
  describePeriod,
  installmentStatusId,
} from "@/lib/request/schedule";
import {
  RECEIPT_CLAIM,
  RECEIPT_VERSION,
  receiptToJson,
  receiptTypedData,
  signatureParts,
  verifyPath,
  type Receipt,
} from "@/lib/request/receipt";
import type { RequestStatus } from "@/lib/request/types";
import {
  DEFAULT_TOKEN,
  MAINNET_CHAIN_ID,
  PRIVACY_WALLETS,
  VOYAGER_TX_URL,
  normalizeAddress,
  sameAddress,
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
          Register from your wallet's privacy section — it holds the viewing key,
          so no dapp can do this for you.
        </p>
        <button
          type="button"
          onClick={() => void refreshBalances()}
          className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-[#14101f] transition hover:brightness-110"
        >
          I've registered — recheck
        </button>
      </Panel>
    );
  } else if (poolStatus === "unsupported") {
    balanceSection = (
      <Panel title="This wallet doesn't support STRK20">
        <p className="text-sm text-muted">
          Reading a shielded balance needs the STRK20 wallet API.{" "}
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

/**
 * Where a request's status lives: per installment for a recurring link, so the
 * badge tracks *this* period rather than the first one ever paid.
 *
 * Safe to call during render — `entries` only arrives after mount, so nothing
 * clock-dependent is ever server-rendered.
 */
function statusKeyFor(entry: HistoryEntry): string {
  return entry.schedule
    ? installmentStatusId(entry.id, currentInstallment(entry.schedule).index)
    : entry.id;
}

/**
 * How often the dashboard re-reads state that changes without anyone touching
 * this page: status is written by the payer's browser, and a shielded balance
 * moves when a transfer lands.
 *
 * It's a local API call, so it can poll briskly.
 */
const STATUS_POLL_MS = 15_000;

function RequestList() {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [statuses, setStatuses] = useState<Record<string, RequestStatus>>({});
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [signing, setSigning] = useState<string | null>(null);
  const { account, address } = useWallet();

  // History lives in localStorage, which only exists after mount — reading it
  // during render would differ between server and client.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEntries(loadHistory());
  }, []);

  // A payer marks a request submitted from *their* browser, so this list goes
  // stale on its own. Poll while the tab is visible, and re-read the moment it
  // becomes visible again rather than making someone wait out an interval.
  useEffect(() => {
    if (entries.length === 0) return;

    // Guarded so a slow response for an earlier entry list can't overwrite the
    // statuses of a newer one.
    let cancelled = false;

    async function read() {
      const results = await Promise.all(
        entries.map(async (entry) => {
          try {
            const response = await fetch(`/api/status/${statusKeyFor(entry)}`);
            if (!response.ok) {
              return [entry.id, "pending" as RequestStatus] as const;
            }
            const body = await response.json();
            return [entry.id, body.record.status as RequestStatus] as const;
          } catch {
            return [entry.id, "pending" as RequestStatus] as const;
          }
        })
      );
      if (cancelled) return;

      setStatuses((previous) => {
        const next = Object.fromEntries(results) as Record<string, RequestStatus>;
        // A confirmation made here a moment ago outranks a poll that was already
        // in flight: `confirmed` is terminal, so it can only be the newer fact.
        for (const [id, status] of Object.entries(previous)) {
          if (status === "confirmed") next[id] = "confirmed";
        }
        return next;
      });
    }

    const tick = () => {
      if (document.visibilityState === "visible") void read();
    };

    void read();
    const timer = setInterval(tick, STATUS_POLL_MS);
    document.addEventListener("visibilitychange", tick);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [entries]);

  /**
   * Marking a request received by hand.
   *
   * A payment made through a Whisper Pay link settles itself — the payer's
   * browser reports the transaction and the server verifies it. This is for the
   * rest: money that arrived without a report, because the payer paid straight
   * from their wallet, or reported it from a tab that never finished loading.
   *
   * It's the recipient's own judgement, made after looking at their shielded
   * balance above. Nothing here checks it, because nothing here can.
   */
  async function confirm(statusId: string, entryId: string) {
    try {
      await fetch(`/api/status/${statusId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "confirm" }),
      });
      setStatuses((prev) => ({ ...prev, [entryId]: "confirmed" }));
    } catch {
      /* leave the badge as it was */
    }
  }

  /**
   * Signing a receipt for a request that was paid.
   *
   * The signature has to come from the account the request was addressed to —
   * that's the entire content of the claim, so no other account can stand in.
   * Nothing is sent anywhere: the artifact is assembled here and handed to the
   * recipient to pass on as they see fit.
   */
  async function generateReceipt(entry: HistoryEntry) {
    setReceipt(null);
    setReceiptError(null);

    if (!account || !address) {
      setReceiptError(
        "Connect the wallet this request was addressed to — a receipt is its signature, so nothing else can produce one."
      );
      return;
    }
    // Padded or not, one account is one account — see `sameAddress`.
    if (!sameAddress(address, entry.recipient)) {
      setReceiptError(
        `This request was addressed to ${shortAddress(entry.recipient)}, but you're connected as ${shortAddress(address)}. Switch to that account to sign for it.`
      );
      return;
    }

    const request = statusKeyFor(entry);
    const issuedAt = Math.floor(Date.now() / 1000);
    setSigning(entry.id);

    try {
      const signature = await account.signMessage(
        receiptTypedData(request, issuedAt)
      );

      const parts = signatureParts(signature);
      if (!parts) {
        setReceiptError(
          "Your wallet returned a signature in a form Whisper Pay can't read, so there's no receipt to hand over — one built from it would fail every check. Nothing was sent anywhere."
        );
        return;
      }

      setReceipt({
        version: RECEIPT_VERSION,
        request,
        claim: RECEIPT_CLAIM,
        issuedAt,
        recipient: address,
        signature: parts,
      });
    } catch (error) {
      // Declining in the wallet needs no explaining. Everything else does —
      // a wallet without `wallet_signTypedData` fails here too, and silence
      // leaves the recipient pressing a button that appears to do nothing.
      const failure = describeStrk20Error(error);
      setReceiptError(
        failure.benign
          ? null
          : `Your wallet couldn't sign this receipt.${
              failure.raw ? ` It said: ${failure.raw}` : ""
            }`
      );
    } finally {
      setSigning(null);
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
          const cycle = entry.schedule
            ? currentInstallment(entry.schedule)
            : null;
          return (
            <li key={entry.id} className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="tabular text-sm font-medium">
                  {formatDisplay(BigInt(entry.amount), DEFAULT_TOKEN.decimals)}{" "}
                  {DEFAULT_TOKEN.symbol}
                  {entry.schedule ? (
                    <span className="font-normal text-muted">
                      {" "}
                      / {describePeriod(entry.schedule).toLowerCase()}
                    </span>
                  ) : null}
                  {entry.memo ? (
                    <span className="ml-2 font-normal text-muted">{entry.memo}</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs text-muted">
                  {entry.recipientName ? `${entry.recipientName} · ` : ""}
                  {cycle
                    ? cycle.ended
                      ? "Finished"
                      : `Payment ${cycle.number}${cycle.total ? ` of ${cycle.total}` : ""} due ${new Date(cycle.dueAt * 1000).toLocaleDateString()}`
                    : new Date(entry.createdAt * 1000).toLocaleDateString()}
                </p>
              </div>

              <StatusBadge status={status} />

              <div className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  title="Copy the payment link — this is the invoice"
                  onClick={() => void navigator.clipboard.writeText(entry.url)}
                  className="rounded-lg border border-hairline px-2 py-1 text-xs transition hover:bg-surface-raised"
                >
                  Copy
                </button>
                <button
                  type="button"
                  title="Copy the status link — paid or unpaid, nothing else"
                  onClick={() =>
                    void navigator.clipboard.writeText(
                      `${window.location.origin}${statusPath(entry.id, entry.schedule)}`
                    )
                  }
                  className="rounded-lg border border-hairline px-2 py-1 text-xs text-muted transition hover:bg-surface-raised hover:text-foreground"
                >
                  Status
                </button>
                {status === "confirmed" ? (
                  <button
                    type="button"
                    title="Sign a receipt saying this request was paid"
                    onClick={() => void generateReceipt(entry)}
                    disabled={signing === entry.id}
                    className="rounded-lg border border-hairline px-2 py-1 text-xs transition hover:bg-surface-raised disabled:opacity-50"
                  >
                    {signing === entry.id ? "Signing…" : "Receipt"}
                  </button>
                ) : null}
                {status === "pending" ? (
                  <button
                    type="button"
                    title="Mark as received — for money that arrived without a report"
                    onClick={() => void confirm(statusKeyFor(entry), entry.id)}
                    className="rounded-lg border border-emerald-400/40 px-2 py-1 text-xs text-emerald-300 transition hover:bg-emerald-400/10"
                  >
                    Mark received
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

      {receiptError ? (
        <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-200/80">
          {receiptError}
        </p>
      ) : null}

      {receipt ? <ReceiptPanel receipt={receipt} onClose={() => setReceipt(null)} /> : null}

      <p className="mt-4 border-t border-hairline pt-4 text-xs leading-relaxed text-muted">
        <strong className="font-medium text-foreground">
          What "received" means:
        </strong>{" "}
        a payer reported a transaction and the server checked it against the
        chain — it exists, it succeeded, it went through the pool. It can't be
        checked against <em>this</em> request, since the transfer hides its
        amount and parties, so your shielded balance above stays the last word.
        Open a request's status link to see the transaction itself.
      </p>
      {entries.some((entry) => entry.schedule) ? (
        <p className="mt-3 text-xs leading-relaxed text-muted">
          <strong className="font-medium text-foreground">Recurring links</strong>{" "}
          show the period that's currently due — each one is tracked separately,
          so confirming this month doesn't mark next month paid. To cancel one,
          stop sharing it: nothing can be charged without the payer approving it.
        </p>
      ) : null}
    </section>
  );
}

function shortAddress(address: string): string {
  return address.length <= 13
    ? address
    : `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/**
 * The signed receipt, ready to hand over.
 *
 * Offered as a file and as a link because the two audiences differ: an
 * accountant wants something to keep, a client wants something to click. Both
 * carry the identical signed payload — the link is just the JSON, encoded into
 * the URL, so checking it needs no server holding a copy.
 */
function ReceiptPanel({
  receipt,
  onClose,
}: {
  receipt: Receipt;
  onClose: () => void;
}) {
  const json = receiptToJson(receipt);

  function download() {
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" })
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `whisperpay-receipt-${receipt.request}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mt-4 rounded-xl border border-hairline bg-surface-raised/40 p-4">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Receipt signed</p>
          <p className="mt-1 text-xs leading-relaxed text-muted">
            You've asserted "{RECEIPT_CLAIM}" for request{" "}
            <span className="font-mono">{receipt.request}</span>, and signed it
            with this account. Anyone can check that signature without asking
            us. It says nothing about the amount, which isn't in the signed
            message, and nothing about who paid, which nobody can know.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          title="Dismiss"
          className="shrink-0 rounded-lg border border-hairline px-2 py-1 text-xs text-muted transition hover:bg-surface-raised"
        >
          ×
        </button>
      </div>

      <pre className="mt-3 max-h-48 overflow-auto rounded-lg border border-hairline bg-surface p-3 font-mono text-[11px] leading-relaxed">
        {json}
      </pre>

      <div className="mt-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={download}
          className="rounded-lg border border-hairline px-2.5 py-1 text-xs transition hover:bg-surface-raised"
        >
          Download JSON
        </button>
        <button
          type="button"
          onClick={() => void navigator.clipboard.writeText(json)}
          className="rounded-lg border border-hairline px-2.5 py-1 text-xs transition hover:bg-surface-raised"
        >
          Copy JSON
        </button>
        <button
          type="button"
          onClick={() =>
            void navigator.clipboard.writeText(
              `${window.location.origin}${verifyPath(receipt)}`
            )
          }
          className="rounded-lg border border-hairline px-2.5 py-1 text-xs transition hover:bg-surface-raised"
        >
          Copy verify link
        </button>
        <Link
          href={verifyPath(receipt)}
          className="rounded-lg border border-hairline px-2.5 py-1 text-xs text-muted transition hover:bg-surface-raised hover:text-foreground"
        >
          Check it yourself ↗
        </Link>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted">
        A receipt is your word, signed — the same standing as a signed paper
        receipt, not a cryptographic proof that money moved. It's for showing an
        accountant or a client that a request was fulfilled; it carries no
        weight in a dispute about whether you were paid, since you're the one
        signing it.
      </p>
    </div>
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
