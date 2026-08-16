"use client";

import { useEffect, useMemo, useState } from "react";

import ConnectWallet from "@/components/wallet/ConnectWallet";
import { useWallet } from "@/components/wallet/walletStore";
import { formatDisplay } from "@/lib/amount";
import type { NameCheck } from "@/lib/identity/starknetid";
import { isExpired } from "@/lib/request/types";
import {
  findToken,
  normalizeAddress,
  MAINNET_CHAIN_ID,
  PRIVACY_WALLETS,
  VOYAGER_TX_URL,
} from "@/lib/strk20/constants";
import { describeStrk20Error, type Strk20Failure } from "@/lib/strk20/errors";
import { planPayment } from "@/lib/strk20/plan";
import { mainnetProvider } from "@/lib/strk20/provider";

/** Serializable form of a PaymentRequest — `amount` crosses as a string. */
export interface PayRequestDto {
  id: string;
  recipient: string;
  recipientName?: string;
  token: string;
  amount: string;
  memo?: string;
  createdAt: number;
  expiresAt?: number;
}

type Phase =
  | { name: "idle" }
  | { name: "awaiting-wallet" }
  | { name: "confirming"; txHash: string }
  | { name: "paid"; txHash: string }
  | { name: "failed"; failure: Strk20Failure };

export default function PayClient({
  request,
  nameCheck,
}: {
  request: PayRequestDto;
  nameCheck?: NameCheck | null;
}) {
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

  const [phase, setPhase] = useState<Phase>({ name: "idle" });
  const [roundUp, setRoundUp] = useState(false);
  const [expired, setExpired] = useState(false);

  const token = findToken(request.token);
  const amount = BigInt(request.amount);
  const onMainnet = isConnected && chainId === MAINNET_CHAIN_ID;

  // Evaluated after mount rather than during render: `isExpired` reads the
  // clock, and letting the server and the client disagree about the time would
  // be a hydration mismatch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExpired(isExpired(request));
  }, [request]);

  // Balances are per-account and per-network, so read them once we have both.
  useEffect(() => {
    if (onMainnet && balances === undefined && !balancesLoading) {
      void refreshBalances();
    }
  }, [onMainnet, balances, balancesLoading, refreshBalances]);

  const shieldedBalance = balances?.[normalizeAddress(request.token)] ?? 0n;

  const plan = useMemo(() => {
    if (!token) return null;
    try {
      return planPayment({
        tokenAddress: request.token,
        amount,
        recipient: request.recipient,
        shieldedBalance,
        shieldRoundingStep: roundUp ? token.shieldRoundingStep : undefined,
      });
    } catch {
      return null;
    }
  }, [token, request.token, request.recipient, amount, shieldedBalance, roundUp]);

  if (!token) {
    return (
      <Card>
        <h1 className="text-lg font-semibold">Unsupported token</h1>
        <p className="mt-2 text-sm text-muted">
          This link asks for a token Whisper Pay doesn't handle.
        </p>
      </Card>
    );
  }

  async function pay() {
    if (!account || !plan) return;
    setPhase({ name: "awaiting-wallet" });

    let txHash: string;
    try {
      const result = await account.strk20InvokeTransaction(plan.actions);
      txHash = result.transaction_hash;
    } catch (error) {
      setPhase({ name: "failed", failure: describeStrk20Error(error) });
      return;
    }

    setPhase({ name: "confirming", txHash });

    try {
      // Pool transactions verify a STARK proof on-chain, so the budget here is
      // generous — 400 × 3s ≈ 20 minutes before we stop waiting.
      await mainnetProvider.waitForTransaction(txHash, {
        retries: 400,
        retryInterval: 3000,
      });
    } catch {
      // The transaction may still land; we just stopped watching.
    }

    setPhase({ name: "paid", txHash });
    void refreshBalances();

    // Best-effort status report. The payment is already done — a failure here
    // only means the recipient's dashboard won't show it as submitted.
    void fetch(`/api/status/${request.id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ txHash }),
    }).catch(() => {});
  }

  const amountLabel = `${formatDisplay(amount, token.decimals)} ${token.symbol}`;

  return (
    <div className="space-y-5">
      <Card>
        <p className="text-xs font-medium tracking-wide text-muted uppercase">
          Payment request
        </p>
        <p className="tabular mt-2 text-4xl font-semibold">{amountLabel}</p>
        {request.memo ? (
          <p className="mt-2 text-sm text-foreground/80">{request.memo}</p>
        ) : null}

        <dl className="mt-5 space-y-2 border-t border-hairline pt-4 text-sm">
          <Row label="To">
            {request.recipientName && nameCheck?.state === "match" ? (
              <span className="flex flex-col items-end gap-0.5">
                <span className="font-medium">{request.recipientName}</span>
                <span className="font-mono text-[11px] break-all text-muted">
                  {request.recipient}
                </span>
              </span>
            ) : (
              <span className="font-mono text-xs break-all">{request.recipient}</span>
            )}
          </Row>
          <Row label="Network">Starknet mainnet</Row>
          {request.expiresAt ? (
            <Row label={expired ? "Expired" : "Expires"}>
              {new Date(request.expiresAt * 1000).toLocaleString()}
            </Row>
          ) : null}
        </dl>
      </Card>

      {nameCheck?.state === "moved" ? (
        <Notice tone="warn" title={`${nameCheck.name} no longer points here`}>
          When this link was created, {nameCheck.name} resolved to the address
          above. It now resolves to{" "}
          {nameCheck.actual ? (
            <span className="font-mono">{nameCheck.actual}</span>
          ) : (
            "nothing"
          )}
          . Names can be sold or re-pointed, so Whisper Pay pays the address the
          link was made with — never the name's current owner. Check with whoever
          sent you this link before paying.
        </Notice>
      ) : null}

      {expired ? (
        <Notice tone="warn" title="This link has expired">
          Ask whoever sent it for a fresh one. Paying an expired request would
          still move funds, so Whisper Pay won't submit it.
        </Notice>
      ) : phase.name === "paid" ? (
        <PaidCard txHash={phase.txHash} amountLabel={amountLabel} />
      ) : (
        <Card>
          {!isConnected ? (
            <>
              <h2 className="text-sm font-semibold">Pay privately</h2>
              <p className="mt-1 mb-4 text-sm text-muted">
                Connect a Starknet wallet with STRK20 support.
              </p>
              <ConnectWallet />
            </>
          ) : !onMainnet ? (
            <>
              <h2 className="text-sm font-semibold">Switch to mainnet</h2>
              <p className="mt-1 mb-4 text-sm text-muted">
                Whisper Pay only runs against the live STRK20 pool on Starknet
                mainnet.
              </p>
              <button
                type="button"
                onClick={() => void switchToMainnet()}
                className="w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-[#14101f] transition hover:brightness-110"
              >
                Switch network
              </button>
            </>
          ) : poolStatus === "unsupported" ? (
            <Notice tone="warn" title="This wallet doesn't support STRK20">
              Whisper Pay needs the STRK20 privacy API to shield and transfer.{" "}
              <WalletLinks /> support it today.
            </Notice>
          ) : poolStatus === "not-registered" ? (
            <>
              <Notice tone="warn" title="Register with the privacy pool first">
                Every pool user publishes a viewing key once, on-chain, before
                they can send or receive private payments. Your wallet does this
                itself — open its privacy section and register, then come back.
                It takes one transaction.
              </Notice>
              <button
                type="button"
                onClick={() => void refreshBalances()}
                className="mt-4 w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-[#14101f] transition hover:brightness-110"
              >
                I've registered — recheck
              </button>
            </>
          ) : balances === undefined ? (
            <p className="text-sm text-muted">Reading your shielded balance…</p>
          ) : plan ? (
            <PlanView
              plan={plan}
              token={token}
              roundUp={roundUp}
              onRoundUpChange={setRoundUp}
              phase={phase}
              onPay={pay}
              payerAddress={address}
            />
          ) : null}

          {phase.name === "failed" ? (
            <FailureCard failure={phase.failure} onRetry={() => setPhase({ name: "idle" })} />
          ) : null}
        </Card>
      )}
    </div>
  );
}

function PlanView({
  plan,
  token,
  roundUp,
  onRoundUpChange,
  phase,
  onPay,
  payerAddress,
}: {
  plan: NonNullable<ReturnType<typeof planPayment>>;
  token: NonNullable<ReturnType<typeof findToken>>;
  roundUp: boolean;
  onRoundUpChange: (next: boolean) => void;
  phase: Phase;
  onPay: () => void;
  payerAddress: string;
}) {
  const fmt = (value: bigint) =>
    `${formatDisplay(value, token.decimals)} ${token.symbol}`;
  const busy = phase.name === "awaiting-wallet" || phase.name === "confirming";
  const shielding = plan.strategy === "shield-and-transfer";

  return (
    <>
      <h2 className="text-sm font-semibold">
        {shielding ? "Shield and pay, in one transaction" : "Pay from your shielded balance"}
      </h2>

      <dl className="mt-4 space-y-2 text-sm">
        {plan.coveredByBalance > 0n ? (
          <Row label="From shielded balance">
            <span className="tabular">{fmt(plan.coveredByBalance)}</span>
          </Row>
        ) : null}
        {shielding ? (
          <Row label="Shield now (public)">
            <span className="tabular">{fmt(plan.depositAmount)}</span>
          </Row>
        ) : null}
        <Row label="Private transfer">
          <span className="tabular">{fmt(plan.transferAmount)}</span>
        </Row>
        {plan.surplus > 0n ? (
          <Row label="Stays shielded">
            <span className="tabular text-muted">{fmt(plan.surplus)}</span>
          </Row>
        ) : null}
      </dl>

      {shielding ? (
        <div className="mt-4 rounded-xl border border-hairline bg-background p-4">
          <p className="text-xs leading-relaxed text-muted">
            You don't hold enough in the pool yet, so this transaction does two
            things at once: it deposits {fmt(plan.depositAmount)} and then pays
            privately. Both settle together — if either fails, neither happens.
          </p>

          {plan.revealsAmount ? (
            <div className="mt-3 rounded-lg bg-amber-400/10 p-3">
              <p className="text-xs leading-relaxed text-amber-200/90">
                <strong className="font-semibold">Heads up:</strong> the deposit
                is public and it's exactly the amount being paid. Anyone watching
                the pool can put those two together. Rounding the deposit up
                breaks the match — the extra stays in your shielded balance.
              </p>
            </div>
          ) : null}

          <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-xs">
            <input
              type="checkbox"
              checked={roundUp}
              onChange={(event) => onRoundUpChange(event.target.checked)}
              className="size-4 accent-[var(--accent)]"
            />
            <span>
              Round the deposit up to the nearest{" "}
              {formatDisplay(token.shieldRoundingStep, token.decimals)}{" "}
              {token.symbol}
            </span>
          </label>
        </div>
      ) : (
        <p className="mt-4 rounded-xl border border-hairline bg-background p-4 text-xs leading-relaxed text-muted">
          You're paying entirely from funds already inside the pool. This is a
          note-to-note transfer: no amount and no parties appear on-chain.
        </p>
      )}

      <button
        type="button"
        disabled={busy}
        onClick={onPay}
        className="mt-5 w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-[#14101f] transition hover:brightness-110 disabled:opacity-60"
      >
        {phase.name === "awaiting-wallet"
          ? "Approve in your wallet…"
          : phase.name === "confirming"
            ? "Confirming on-chain…"
            : `Pay ${fmt(plan.transferAmount)}`}
      </button>

      {phase.name === "awaiting-wallet" ? (
        <p className="mt-2.5 text-center text-xs text-muted">
          Your wallet is generating a zero-knowledge proof. This can take a
          minute or two.
        </p>
      ) : phase.name === "confirming" ? (
        <p className="mt-2.5 text-center text-xs text-muted">
          Submitted. Waiting for the proof to verify on-chain.
        </p>
      ) : payerAddress ? (
        <p className="mt-2.5 text-center text-xs text-muted">
          Paying from {payerAddress.slice(0, 6)}…{payerAddress.slice(-4)}
        </p>
      ) : null}
    </>
  );
}

function PaidCard({ txHash, amountLabel }: { txHash: string; amountLabel: string }) {
  return (
    <Card>
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-full bg-emerald-400/15 text-sm text-emerald-400">
          ✓
        </span>
        <h2 className="font-semibold">Paid {amountLabel}</h2>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        The private transfer is on-chain. The recipient sees it in their shielded
        balance — nobody else sees the amount or who it went to.
      </p>
      <a
        href={`${VOYAGER_TX_URL}${txHash}`}
        target="_blank"
        rel="noreferrer"
        className="mt-4 inline-block rounded-xl border border-hairline px-4 py-2 font-mono text-xs transition hover:bg-surface-raised"
      >
        {txHash.slice(0, 10)}…{txHash.slice(-6)} ↗
      </a>
    </Card>
  );
}

function FailureCard({
  failure,
  onRetry,
}: {
  failure: Strk20Failure;
  onRetry: () => void;
}) {
  return (
    <div
      className={`mt-5 rounded-xl border p-4 ${
        failure.benign
          ? "border-hairline bg-background"
          : "border-red-500/30 bg-red-500/5"
      }`}
    >
      <p className="text-sm font-medium">{failure.title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">{failure.detail}</p>

      {failure.raw && !failure.benign ? (
        <details className="mt-2.5">
          <summary className="cursor-pointer text-xs text-muted">
            Technical details
          </summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-background p-2.5 font-mono text-[11px] whitespace-pre-wrap text-muted">
            {failure.raw}
          </pre>
        </details>
      ) : null}

      <button
        type="button"
        onClick={onRetry}
        className="mt-3 rounded-lg border border-hairline px-3 py-1.5 text-xs transition hover:bg-surface-raised"
      >
        Try again
      </button>
    </div>
  );
}

/** "Ready and Xverse", each linked — the wallets that implement STRK20. */
function WalletLinks() {
  return (
    <>
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
      ))}
    </>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-hairline bg-surface p-6">
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warn";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        tone === "warn" ? "border-amber-400/30 bg-amber-400/5" : ""
      }`}
    >
      <p className="text-sm font-medium">{title}</p>
      <p className="mt-1 text-xs leading-relaxed text-muted">{children}</p>
    </div>
  );
}
