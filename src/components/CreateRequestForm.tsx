"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { useWallet } from "@/components/wallet/walletStore";
import { isStarkDomain } from "@/lib/identity/encoding";
import { saveToHistory } from "@/lib/request/history";
import { EXPIRY_PRESETS, MAX_MEMO_LENGTH } from "@/lib/request/types";
import { DEFAULT_TOKEN, isValidAddress } from "@/lib/strk20/constants";

interface CreatedLink {
  id: string;
  url: string;
  path: string;
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedLink | null>(null);
  const [copied, setCopied] = useState(false);

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
          expiresIn: EXPIRY_PRESETS[expiryIndex].seconds,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not create the request.");
        return;
      }
      setCreated({ id: body.id, url: body.url, path: body.path });
      setCopied(false);

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
      });
    } catch {
      setError("Could not reach the server. Check your connection and retry.");
    } finally {
      setSubmitting(false);
    }
  }

  async function copyLink() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy automatically — select the link and copy it.");
    }
  }

  if (created) {
    return (
      <section className="rounded-2xl border border-hairline bg-surface p-6">
        <h2 className="text-lg font-semibold">Your payment link is ready</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Anyone with this link can pay you privately. The request lives entirely
          in the link — there's no database entry to lose.
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value={created.url}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 rounded-xl border border-hairline bg-background px-3 py-2.5 font-mono text-xs"
          />
          <button
            type="button"
            onClick={copyLink}
            className="rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-[#14101f] transition hover:brightness-110"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="mt-5 flex flex-wrap gap-3 text-sm">
          <Link
            href={created.path}
            className="rounded-xl border border-hairline px-4 py-2 transition hover:bg-surface-raised"
          >
            Open payer view
          </Link>
          <button
            type="button"
            onClick={() => {
              setCreated(null);
              setAmount("");
              setMemo("");
            }}
            className="rounded-xl border border-hairline px-4 py-2 transition hover:bg-surface-raised"
          >
            Create another
          </button>
        </div>

        {error ? <p className="mt-4 text-xs text-red-400">{error}</p> : null}
      </section>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-hairline bg-surface p-6"
    >
      <h2 className="text-lg font-semibold">Request a payment</h2>
      <p className="mt-1 text-sm text-muted">
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
              className={`min-w-0 flex-1 rounded-xl border bg-background px-3 py-2.5 font-mono text-xs outline-none transition focus:border-accent ${
                recipientValid ? "border-hairline" : "border-red-500/60"
              }`}
            />
            {isConnected && address ? (
              <button
                type="button"
                onClick={() => setRecipient(address)}
                className="shrink-0 rounded-xl border border-hairline px-3 text-xs text-muted transition hover:bg-surface-raised hover:text-foreground"
              >
                Use mine
              </button>
            ) : null}
          </div>
          <ResolutionHint resolution={resolution} typed={recipient} />
        </Field>

        <Field label="Amount">
          <div className="flex items-center gap-2 rounded-xl border border-hairline bg-background px-3 py-2.5 transition focus-within:border-accent">
            <input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.0"
              required
              className="tabular min-w-0 flex-1 bg-transparent text-2xl font-medium outline-none"
            />
            <span className="shrink-0 rounded-lg bg-surface-raised px-2.5 py-1 text-xs font-medium">
              {DEFAULT_TOKEN.symbol}
            </span>
          </div>
        </Field>

        <Field label="Note" hint="Shown to the payer. Never goes on-chain.">
          <input
            value={memo}
            onChange={(event) => setMemo(event.target.value)}
            maxLength={MAX_MEMO_LENGTH}
            placeholder="Invoice #42"
            className="w-full rounded-xl border border-hairline bg-background px-3 py-2.5 text-sm outline-none transition focus:border-accent"
          />
        </Field>

        <Field label="Link expires">
          <div className="flex flex-wrap gap-2">
            {EXPIRY_PRESETS.map((preset, index) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => setExpiryIndex(index)}
                className={`rounded-lg border px-3 py-1.5 text-xs transition ${
                  index === expiryIndex
                    ? "border-accent bg-accent-soft text-foreground"
                    : "border-hairline text-muted hover:bg-surface-raised"
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {error ? <p className="mt-5 text-sm text-red-400">{error}</p> : null}

      <button
        type="submit"
        disabled={submitting}
        className="mt-6 w-full rounded-xl bg-accent px-4 py-3 text-sm font-semibold text-[#14101f] transition hover:brightness-110 disabled:opacity-50"
      >
        {submitting ? "Creating…" : "Create payment link"}
      </button>
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
    return <p className="mt-1.5 text-xs text-red-400">{resolution.message}</p>;
  }

  const typedAName = typed.toLowerCase().endsWith(".stark");

  return (
    <p className="mt-1.5 font-mono text-xs break-all text-emerald-300/90">
      {typedAName
        ? `→ ${resolution.address}`
        : resolution.name
          ? `→ ${resolution.name}`
          : null}
    </p>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium tracking-wide text-muted uppercase">
        {label}
      </span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs text-muted">{hint}</span> : null}
    </label>
  );
}
