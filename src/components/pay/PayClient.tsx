"use client";

import { useEffect, useMemo, useState } from "react";

import ConnectWallet from "@/components/wallet/ConnectWallet";
import { useWallet } from "@/components/wallet/walletStore";
import { formatDisplay } from "@/lib/amount";
import type { NameCheck } from "@/lib/identity/starknetid";
import {
  currentInstallment,
  describePeriod,
  installmentStatusId,
  type Installment,
  type Schedule,
} from "@/lib/request/schedule";
import { loadHistory, saveToHistory } from "@/lib/request/history";
import { recipientCommitment } from "@/lib/request/proof";
import { isExpired, type RequestStatus } from "@/lib/request/types";
import {
  findToken,
  normalizeAddress,
  MAINNET_CHAIN_ID,
  PRIVACY_WALLETS,
  VOYAGER_TX_URL,
} from "@/lib/strk20/constants";
import { describeStrk20Error, type Strk20Failure } from "@/lib/strk20/errors";
import { planPayment } from "@/lib/strk20/plan";
import { assessPrivacy, type PrivacyLevel } from "@/lib/strk20/privacy";
import { mainnetProvider } from "@/lib/strk20/provider";

/**
 * Backoff for re-reporting a payment whose receipt the server couldn't read
 * yet. Roughly a minute in total, which comfortably outlasts the gap between
 * submitting a transaction and it appearing in a block.
 */
const REPORT_RETRY_DELAYS_MS = [5000, 15000, 30000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  /** Present when this link asks for the same amount every period. */
  schedule?: Schedule;
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
  const [installment, setInstallment] = useState<Installment | null>(null);
  const [settled, setSettled] = useState<RequestStatus | null>(null);
  const [payAnyway, setPayAnyway] = useState(false);
  const [reportFailed, setReportFailed] = useState(false);

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

  // Which installment a recurring link is asking for also depends on the clock,
  // so it's resolved here for the same reason.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInstallment(
      request.schedule ? currentInstallment(request.schedule) : null
    );
  }, [request]);

  /** Per-installment for a recurring link; the bare id for a one-off. */
  const statusId = installment
    ? installmentStatusId(request.id, installment.index)
    : request.id;

  // "Has this already been paid?", asked before showing a Pay button.
  //
  // A payment link is a URL: it gets bookmarked, forwarded, and opened again
  // out of habit, and nothing about it looks different afterwards. That's true
  // of a one-off invoice and of a subscription, where a payer also can't tell
  // this month's ask from last month's by looking.
  //
  // Advisory only — the store is optional and status can't prove payment, so
  // `SettledCard` warns and hands the payer the last word.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/status/${statusId}`);
        if (!response.ok) return;
        const body = await response.json();
        const status = body.record?.status as RequestStatus | undefined;
        if (!cancelled && (status === "submitted" || status === "confirmed")) {
          setSettled(status);
        }
      } catch {
        /* status is a convenience — paying never depends on it */
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [installment, statusId]);

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

    // Reported *before* the wait below, not after it. The wait runs for up to
    // twenty minutes, and the recipient watching the status link shouldn't have
    // to sit through it to see "submitted" — especially since the server
    // re-verifies the hash against the chain itself and doesn't need this page
    // to have finished anything.
    const firstReport = reportPayment(txHash);

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

    // The early report can legitimately fail: the server verifies by reading a
    // receipt, and a transaction submitted a second ago doesn't have one yet.
    // So back off and try again rather than stranding the status page on a
    // transaction whose only problem is being young. Only after all of that is
    // the failure real enough to put in front of the payer.
    void (async () => {
      if (await firstReport) return;
      for (const delay of REPORT_RETRY_DELAYS_MS) {
        await sleep(delay);
        if (await reportPayment(txHash)) return;
      }
      setReportFailed(true);
    })();
  }

  /**
   * Tell the status store a payment went out. Returns whether it stuck.
   *
   * The payment itself is already on-chain and unaffected by any of this, but a
   * silent failure here strands the recipient on "Awaiting payment" forever
   * with nothing to click, so the caller surfaces it instead of swallowing it.
   *
   * `keepalive` so a payer who closes the tab on the receipt still reports.
   */
  async function reportPayment(txHash: string): Promise<boolean> {
    try {
      // Computed here, from the address in the link, so the server learns a
      // hash instead of a recipient. It's what later lets that recipient — and
      // only them — read this hash back. See `proof.ts`.
      const commitment = await recipientCommitment(statusId, request.recipient);

      const response = await fetch(`/api/status/${statusId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash, recipientCommitment: commitment }),
        keepalive: true,
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  const amountLabel = `${formatDisplay(amount, token.decimals)} ${token.symbol}`;

  return (
    <div className="space-y-5">
      <Card>
        <p className="text-xs font-medium tracking-wide text-muted uppercase">
          {request.schedule ? "Recurring payment request" : "Payment request"}
        </p>
        <p className="tabular mt-2 text-4xl font-semibold">{amountLabel}</p>
        {request.schedule && installment ? (
          <p className="mt-1.5 text-sm text-muted">
            <span className="text-foreground">
              Payment {installment.number}
              {installment.total ? ` of ${installment.total}` : ""}
            </span>{" "}
            · {describePeriod(request.schedule).toLowerCase()}, each approved in
            your wallet
          </p>
        ) : null}
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
          {installment ? (
            <>
              <Row label={installment.notStarted ? "Starts" : "Due"}>
                {formatDate(installment.dueAt)}
              </Row>
              {installment.nextDueAt ? (
                <Row label="Next payment">
                  <span className="text-muted">
                    {formatDate(installment.nextDueAt)}
                  </span>
                </Row>
              ) : null}
            </>
          ) : request.expiresAt ? (
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

      <AdoptRequest request={request} connectedAddress={address} />

      {expired ? (
        request.schedule ? (
          <Notice tone="warn" title="This subscription has finished">
            Its final payment period is over, so Whisper Pay won't submit another
            one. If it should continue, ask whoever sent it for a fresh link.
          </Notice>
        ) : (
          <Notice tone="warn" title="This link has expired">
            Ask whoever sent it for a fresh one. Paying an expired request would
            still move funds, so Whisper Pay won't submit it.
          </Notice>
        )
      ) : phase.name === "paid" ? (
        <PaidCard
          txHash={phase.txHash}
          amountLabel={amountLabel}
          installment={installment}
          reportFailed={reportFailed}
          onRetryReport={() => {
            void (async () => {
              setReportFailed(!(await reportPayment(phase.txHash)));
            })();
          }}
        />
      ) : settled && !payAnyway ? (
        <SettledCard
          status={settled}
          installment={installment}
          onPayAnyway={() => setPayAnyway(true)}
        />
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

      <PrivacyMeter plan={plan} token={token} />

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

/**
 * What this specific payment publishes, shown before the payer commits.
 *
 * Every word of it comes from the plan `planPayment` already built for these
 * exact numbers — the route it chose, the deposit it sized, whether that
 * deposit gives the amount away. A payer can check the claim against the
 * figures in the table directly above it, which is the point: a privacy notice
 * that reads the same regardless of what's about to happen teaches nobody
 * anything.
 */
function PrivacyMeter({
  plan,
  token,
}: {
  plan: NonNullable<ReturnType<typeof planPayment>>;
  token: NonNullable<ReturnType<typeof findToken>>;
}) {
  const assessment = assessPrivacy(plan, token);
  const style = LEVEL_STYLE[assessment.level];

  return (
    <div className={`mt-4 rounded-xl border p-4 ${style.container}`}>
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">
          On-chain privacy
        </span>
        <span className={`ml-auto text-xs font-semibold ${style.text}`}>
          {assessment.label}
        </span>
      </div>

      <div className="mt-2.5 flex gap-1" aria-hidden>
        {[0, 1, 2].map((segment) => (
          <span
            key={segment}
            className={`h-1.5 flex-1 rounded-full ${
              segment < style.filled ? style.bar : "bg-[var(--hairline)]"
            }`}
          />
        ))}
      </div>

      <p className="mt-3 text-xs leading-relaxed text-muted">
        {assessment.detail}
      </p>

      {assessment.fingerprintNote ? (
        <p className="mt-2.5 border-t border-hairline pt-2.5 text-xs leading-relaxed text-amber-200/80">
          {assessment.fingerprintNote}
        </p>
      ) : null}
    </div>
  );
}

/** Three segments, filled to match the level. */
const LEVEL_STYLE: Record<
  PrivacyLevel,
  { container: string; text: string; bar: string; filled: number }
> = {
  strong: {
    container: "border-emerald-400/30 bg-emerald-400/5",
    text: "text-emerald-300",
    bar: "bg-emerald-400",
    filled: 3,
  },
  moderate: {
    container: "border-hairline bg-background",
    text: "text-accent",
    bar: "bg-accent",
    filled: 2,
  },
  weak: {
    container: "border-amber-400/30 bg-amber-400/5",
    text: "text-amber-300",
    bar: "bg-amber-400",
    filled: 1,
  },
};

/**
 * Putting a request into the dashboard of the person being paid.
 *
 * History is per browser, on purpose — the server keeps no list of who billed
 * whom, so there's nothing to leak and nothing to subpoena. The cost showed up
 * the first time someone made a link on one machine and opened their wallet on
 * another: the request was nowhere to be found on the side that was owed money.
 *
 * This is the seam that fixes it without giving up the property. The payment
 * link already carries the whole request, so a recipient who opens it with
 * their own wallet connected can copy it into their own browser. Nothing is
 * sent anywhere; the button only appears for the account the money is for.
 */
function AdoptRequest({
  request,
  connectedAddress,
}: {
  request: PayRequestDto;
  connectedAddress: string;
}) {
  const [known, setKnown] = useState<boolean | null>(null);

  // localStorage only exists after mount, and whether this request is already
  // in it decides what this renders — so it can't be read during render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKnown(loadHistory().some((entry) => entry.id === request.id));
  }, [request.id]);

  const addressed =
    connectedAddress !== "" &&
    normalizeAddress(connectedAddress) === normalizeAddress(request.recipient);

  if (!addressed || known !== false) return null;

  return (
    <Notice tone="info" title="This request is addressed to you">
      You're connected as its recipient. Add it to your dashboard to track
      whether it gets paid — it's stored in this browser only, and nothing about
      it is sent anywhere.
      <button
        type="button"
        onClick={() => {
          saveToHistory({
            id: request.id,
            path: window.location.pathname,
            url: window.location.href,
            recipient: request.recipient,
            recipientName: request.recipientName,
            token: request.token,
            amount: request.amount,
            memo: request.memo,
            createdAt: request.createdAt,
            expiresAt: request.expiresAt,
            schedule: request.schedule,
          });
          setKnown(true);
        }}
        className="mt-3 block rounded-xl border border-hairline px-4 py-2 text-sm transition hover:bg-surface-raised"
      >
        Add to my dashboard
      </button>
    </Notice>
  );
}

function PaidCard({
  txHash,
  amountLabel,
  installment,
  reportFailed,
  onRetryReport,
}: {
  txHash: string;
  amountLabel: string;
  installment: Installment | null;
  reportFailed: boolean;
  onRetryReport: () => void;
}) {
  return (
    <Card>
      <div className="flex items-center gap-2.5">
        <span className="flex size-7 items-center justify-center rounded-full bg-emerald-400/15 text-sm text-emerald-400">
          ✓
        </span>
        <h2 className="font-semibold">
          Paid {amountLabel}
          {installment
            ? ` — payment ${installment.number}${installment.total ? ` of ${installment.total}` : ""}`
            : ""}
        </h2>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted">
        The private transfer is on-chain. The recipient sees it in their shielded
        balance — nobody else sees the amount or who it went to.
      </p>
      {installment?.nextDueAt ? (
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The next payment is due {formatDate(installment.nextDueAt)}. Keep this
          link — open it again then, and it'll ask for that one.
        </p>
      ) : null}
      <a
        href={`${VOYAGER_TX_URL}${txHash}`}
        target="_blank"
        rel="noreferrer"
        className="mt-4 inline-block rounded-xl border border-hairline px-4 py-2 font-mono text-xs transition hover:bg-surface-raised"
      >
        {txHash.slice(0, 10)}…{txHash.slice(-6)} ↗
      </a>

      {reportFailed ? (
        <div className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-xs leading-relaxed text-amber-200/80">
          Your payment went through — this is only about the status page. It
          couldn't be told about this transaction, so it still reads "awaiting
          payment" for whoever is watching it.
          <button
            type="button"
            onClick={onRetryReport}
            className="mt-2 block rounded-lg border border-amber-400/30 px-3 py-1.5 transition hover:bg-amber-400/10"
          >
            Try telling it again
          </button>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Shown when this installment already has a reported payment against it.
 *
 * Deliberately not a block. The record only proves *a* pool transaction was
 * reported for this period — it can't prove the payment, and the store is
 * optional, so the payer gets the warning and the last word.
 */
function SettledCard({
  status,
  installment,
  onPayAnyway,
}: {
  status: RequestStatus;
  installment: Installment | null;
  onPayAnyway: () => void;
}) {
  const label = installment
    ? `Payment ${installment.number}${installment.total ? ` of ${installment.total}` : ""}`
    : "This request";

  return (
    <Card>
      <h2 className="text-sm font-semibold">
        {label}{" "}
        {status === "confirmed"
          ? "has been received"
          : "has already been submitted"}
      </h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        {status === "confirmed"
          ? "The recipient confirmed this one landed in their shielded balance."
          : `Someone reported a pool transaction for ${
              installment ? "this period" : "this request"
            }. That's not proof of payment — a private transfer hides its amount and parties — so if it wasn't you, or you're not sure it went through, you can still pay.`}
      </p>
      {installment?.nextDueAt ? (
        <p className="mt-2 text-sm leading-relaxed text-muted">
          The next payment is due {formatDate(installment.nextDueAt)}.
        </p>
      ) : null}
      <button
        type="button"
        onClick={onPayAnyway}
        className="mt-4 rounded-xl border border-hairline px-4 py-2 text-sm transition hover:bg-surface-raised"
      >
        Pay it anyway
      </button>
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

/** Dates only ever render after mount, so the payer's own locale is safe here. */
function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
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
  tone: "warn" | "info";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        tone === "warn"
          ? "border-amber-400/30 bg-amber-400/5"
          : "border-hairline bg-surface-raised/40"
      }`}
    >
      <p className="text-sm font-medium">{title}</p>
      {/* A div rather than a p — callers put buttons inside this. */}
      <div className="mt-1 text-xs leading-relaxed text-muted">{children}</div>
    </div>
  );
}
