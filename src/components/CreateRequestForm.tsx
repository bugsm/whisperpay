"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import Button, { buttonClass } from "@/components/ui/Button";
import Choice from "@/components/ui/Choice";
import Field from "@/components/ui/Field";
import { CARD_SURFACE, INSET_SURFACE } from "@/components/ui/surfaces";
import { useWallet } from "@/components/wallet/walletStore";
import { isStarkDomain } from "@/lib/identity/encoding";
import { saveToHistory } from "@/lib/request/history";
import {
  describeSchedule,
  MAX_INSTALLMENTS,
  MIN_INSTALLMENTS,
  SCHEDULE_PRESETS,
} from "@/lib/request/schedule";
import { EXPIRY_PRESETS, MAX_MEMO_LENGTH } from "@/lib/request/types";
import { DEFAULT_TOKEN, isValidAddress } from "@/lib/strk20/constants";

interface CreatedLink {
  id: string;
  url: string;
  path: string;
  /** Shareable proof-of-payment view. Carries no amount and no addresses. */
  statusUrl: string;
  /** Set when the created request recurs — changes what the success card says. */
  scheduleLabel?: string;
}

/** What we know about whatever the user typed into "Paid to". */
type Resolution =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; address: string; name: string | null }
  | { state: "error"; message: string };

export default function CreateRequestForm() {
  const { address, isConnected } = useWallet();

  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [expiryIndex, setExpiryIndex] = useState(2); // 7 days
  const [repeatIndex, setRepeatIndex] = useState(0); // one-off
  const [installments, setInstallments] = useState(""); // blank = until cancelled
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [copied, setCopied] = useState<"pay" | "status" | null>(null);

  // Only the *answer* is state. Everything transient — empty, malformed,
  // still-in-flight — is derived from what's currently typed, so there's no
  // synchronous setState on every keystroke and no chance of the hint
  // disagreeing with the input it describes.
  const [lookup, setLookup] = useState<{ for: string; result: Resolution } | null>(
    null
  );

  const looksValid =
    isValidAddress(recipient) || isStarkDomain(recipient.toLowerCase());
  const recipientValid = recipient === "" || looksValid;

  // Recurrence. A blank count means "until cancelled" — the common case for a
  // subscription, and the reason the field isn't `required`.
  const repeat = SCHEDULE_PRESETS[repeatIndex];
  const recurring = repeat.spec !== null;
  const installmentCount =
    installments.trim() === "" ? null : Number(installments);
  const installmentsValid =
    installmentCount === null ||
    (Number.isInteger(installmentCount) &&
      installmentCount >= MIN_INSTALLMENTS &&
      installmentCount <= MAX_INSTALLMENTS);

  const resolution: Resolution =
    recipient === ""
      ? { state: "idle" }
      : !looksValid
        ? { state: "error", message: "Enter a Starknet address or a .stark name." }
        : lookup?.for === recipient
          ? lookup.result
          : { state: "loading" };

  // Resolve what was typed, debounced. Works both ways: a .stark name shows the
  // address it points at, and an address shows the name that points back at it.
  useEffect(() => {
    if (recipient === "" || !looksValid) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/resolve?identifier=${encodeURIComponent(recipient)}`,
          { signal: controller.signal }
        );
        const body = await response.json();
        setLookup({
          for: recipient,
          result: response.ok
            ? { state: "ok", address: body.address, name: body.name ?? null }
            : { state: "error", message: body.error ?? "Lookup failed." },
        });
      } catch (error) {
        // An aborted request is a superseded keystroke, not a failure.
        if ((error as Error)?.name !== "AbortError") {
          setLookup({
            for: recipient,
            result: { state: "error", message: "Couldn't reach the resolver." },
          });
        }
      }
    }, 400);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [recipient, looksValid]);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError("");

    if (!looksValid) {
      setError("Enter the Starknet address or .stark name that should be paid.");
      return;
    }
    if (resolution.state === "error") {
      setError(resolution.message);
      return;
    }
    if (recurring && !installmentsValid) {
      setError(
        `Number of payments must be between ${MIN_INSTALLMENTS} and ${MAX_INSTALLMENTS}, or blank for no end date.`
      );
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch("/api/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient,
          amount,
          token: DEFAULT_TOKEN.address,
          memo: memo || undefined,
          // A recurring link's lifetime is its schedule's, so the two settings
          // are mutually exclusive — the API rejects both together.
          expiresIn: recurring ? undefined : EXPIRY_PRESETS[expiryIndex].seconds,
          schedule: repeat.spec
            ? { ...repeat.spec, count: installmentCount }
            : undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not create the request.");
        return;
      }
      setCreated({
        id: body.id,
        url: body.url,
        path: body.path,
        statusUrl: body.statusUrl,
        scheduleLabel: body.request.schedule
          ? describeSchedule(body.request.schedule)
          : undefined,
      });
      setCopied(null);

      // Remembered on this device only, so the dashboard can show what this
      // browser has billed without the server ever holding that list.
      saveToHistory({
        id: body.id,
        path: body.path,
        url: body.url,
        recipient: body.request.recipient,
        recipientName: body.request.recipientName ?? undefined,
        token: body.request.token,
        amount: body.request.amount,
        memo: body.request.memo ?? undefined,
        createdAt: body.request.createdAt,
        expiresAt: body.request.expiresAt ?? undefined,
        schedule: body.request.schedule ?? undefined,
      });
    } catch {
      setError("Could not reach the server. Check your connection and retry.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink(value: string, which: "pay" | "status") {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("Couldn't copy automatically — select the link and copy it.");
    }
  }

  if (created) {
    return (
      <section className={CARD_SURFACE}>
        <h2 className="display text-lg">
          {created.scheduleLabel
            ? "Your recurring link is ready"
            : "Your payment link is ready"}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {created.scheduleLabel ? (
            <>
              <span className="text-foreground">{created.scheduleLabel}.</span>{" "}
              Send it once — it asks for the current payment every period, and
              the payer approves each one in their wallet.
            </>
          ) : (
            <>
              Anyone with this link can pay you privately. The request lives
              entirely in the link — there's no database entry to lose.
            </>
          )}
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value={created.url}
            onFocus={(event) => event.currentTarget.select()}
            className={`${INSET_SURFACE} min-w-0 flex-1 px-3 py-2.5 font-mono text-xs`}
          />
          <Button variant="primary" onClick={() => void copyLink(created.url, "pay")}>
            {copied === "pay" ? "Copied" : "Copy"}
          </Button>
        </div>

        {/*
          A second link, for a different audience. The payment link *is* the
          invoice — sharing it to show something was paid also shares the amount
          and both parties. This one shows only the state.
        */}
        <div className={`${INSET_SURFACE} mt-5 p-4`}>
          <p className="display text-xs tracking-wide text-muted uppercase">
            Status link
          </p>
          <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
            <input
              readOnly
              value={created.statusUrl}
              onFocus={(event) => event.currentTarget.select()}
              className="min-w-0 flex-1 border-2 border-hairline bg-surface px-3 py-2 font-mono text-xs"
            />
            <Button
              size="sm"
              onClick={() => void copyLink(created.statusUrl, "status")}
            >
              {copied === "status" ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="mt-2.5 text-xs leading-relaxed text-muted">
            Share this one to show whether you've been paid. It carries no
            amount, neither address, no note and no transaction — only unpaid,
            submitted, or received.
          </p>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <Link href={created.path} className={buttonClass("secondary")}>
            Open payer view
          </Link>
          <Button
            onClick={() => {
              setCreated(null);
              setCopied(null);
              setAmount("");
              setMemo("");
            }}
          >
            Create another
          </Button>
        </div>

        {error ? <p className="mt-4 text-xs text-danger">{error}</p> : null}
      </section>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={CARD_SURFACE}
    >
      <h2 className="display text-lg">Request a payment</h2>
      <p className="mt-2 text-sm text-muted">
        You'll get a link to share. Nothing is published on-chain until someone
        pays.
      </p>

      <div className="mt-6 space-y-5">
        <Field
          label="Paid to"
          hint="A Starknet address or a .stark name, registered with the privacy pool."
        >
          <div className="flex gap-2">
            <input
              value={recipient}
              onChange={(event) => setRecipient(event.target.value.trim())}
              placeholder="alice.stark or 0x…"
              spellCheck={false}
              className={`min-w-0 flex-1 border-2 bg-background px-3 py-2.5 font-mono text-xs outline-none focus:border-accent ${
                recipientValid ? "border-hairline" : "border-danger"
              }`}
            />
            {isConnected && address ? (
              <Button
                size="sm"
                variant="ghost"
                className="shrink-0"
                onClick={() => setRecipient(address)}
              >
                Use mine
              </Button>
            ) : null}
          </div>
          <ResolutionHint resolution={resolution} typed={recipient} />
        </Field>

        <Field label={recurring ? "Amount per payment" : "Amount"}>
          <div
            className={`${INSET_SURFACE} flex items-center gap-2 px-3 py-2.5 focus-within:border-accent`}
          >
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.0"
              required
              className="tabular min-w-0 flex-1 bg-transparent text-2xl font-medium outline-none"
            />
            <span className="display shrink-0 bg-surface-raised px-2.5 py-1 text-xs">
              {DEFAULT_TOKEN.symbol}
            </span>
          </div>
        </Field>

        <Field label="Repeats">
          <div className="flex flex-wrap gap-2">
            {SCHEDULE_PRESETS.map((preset, index) => (
              <Choice
                key={preset.label}
                selected={index === repeatIndex}
                onClick={() => setRepeatIndex(index)}
              >
                {preset.label}
              </Choice>
            ))}
          </div>

          {recurring ? (
            <div className={`${INSET_SURFACE} mt-3 p-4`}>
              {/* Not a <label> — `Field` already is one, and they can't nest. */}
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="text-muted">Number of payments</span>
                <input
                  aria-label="Number of payments"
                  value={installments}
                  onChange={(event) => setInstallments(event.target.value.trim())}
                  inputMode="numeric"
                  placeholder="Until cancelled"
                  className={`tabular w-36 border-2 bg-surface px-2.5 py-1.5 outline-none focus:border-accent ${
                    installmentsValid ? "border-hairline" : "border-danger"
                  }`}
                />
              </div>
              <p className="mt-2.5 text-xs leading-relaxed text-muted">
                The payer approves every payment in their own wallet — a link
                can't charge anyone. Leave the count blank and it simply keeps
                asking until you stop sharing it.
              </p>
            </div>
          ) : null}
        </Field>

        <Field label="Note" hint="Shown to the payer. Never goes on-chain.">
          <input
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            maxLength={MAX_MEMO_LENGTH}
            placeholder="Invoice #42"
            className={`${INSET_SURFACE} w-full px-3 py-2.5 text-sm outline-none focus:border-accent`}
          />
        </Field>

        {recurring ? (
          <Field label="Link expires">
            <p className="text-xs leading-relaxed text-muted">
              {installmentsValid && installmentCount !== null
                ? `When the last of the ${installmentCount} payments is done — a recurring link has to outlive its schedule.`
                : "Never, while it has no end date. Stop sharing it to end the subscription."}
            </p>
          </Field>
        ) : (
          <Field label="Link expires">
            <div className="flex flex-wrap gap-2">
              {EXPIRY_PRESETS.map((preset, index) => (
                <Choice
                  key={preset.label}
                  selected={index === expiryIndex}
                  onClick={() => setExpiryIndex(index)}
                >
                  {preset.label}
                </Choice>
              ))}
            </div>
          </Field>
        )}
      </div>

      {error ? <p className="mt-5 text-sm text-danger">{error}</p> : null}

      <Button
        type="submit"
        variant="primary"
        size="lg"
        disabled={submitting}
        className="mt-6 w-full"
      >
        {submitting
          ? "Creating…"
          : recurring
            ? "Create recurring link"
            : "Create payment link"}
      </Button>
    </form>
  );
}

/**
 * Feedback under the "Paid to" field. A name shows the address it resolves to
 * so the requester can confirm it before sharing; an address shows any name
 * pointing at it, which catches a pasted-the-wrong-thing mistake.
 */
function ResolutionHint({
  resolution,
  typed,
}: {
  resolution: Resolution;
  typed: string;
}) {
  if (resolution.state === "idle") return null;

  if (resolution.state === "loading") {
    return <p className="mt-1.5 text-xs text-muted">Looking up…</p>;
  }

  if (resolution.state === "error") {
    return <p className="mt-1.5 text-xs text-danger">{resolution.message}</p>;
  }

  const typedAName = typed.toLowerCase().endsWith(".stark");

  return (
    <p className="mt-1.5 font-mono text-xs break-all text-ok">
      {typedAName
        ? `→ ${resolution.address}`
        : resolution.name
          ? `→ ${resolution.name}`
          : null}
    </p>
  );
}
