"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import ScanNota, { type ScanResult } from "@/components/bill/ScanNota";
import Button, { buttonClass } from "@/components/ui/Button";
import Choice from "@/components/ui/Choice";
import Field from "@/components/ui/Field";
import { CARD_SURFACE, INSET_SURFACE } from "@/components/ui/surfaces";
import { useWallet } from "@/components/wallet/walletStore";
import { formatDisplay, parseUnits } from "@/lib/amount";
import { allocateEvenly } from "@/lib/bill/allocate";
import { billPath, encodeBill } from "@/lib/bill/codec";
import {
  BillCryptoError,
  encryptBill,
  exportBillKey,
  generateBillKey,
} from "@/lib/bill/crypto";
import {
  MAX_LABEL_LENGTH,
  MAX_SHARES,
  MAX_TITLE_LENGTH,
  MIN_SHARES,
  type BillShare,
  type SplitBill,
} from "@/lib/bill/types";
import { isStarkDomain } from "@/lib/identity/encoding";
import { newRequestId } from "@/lib/request/codec";
import { saveToHistory } from "@/lib/request/history";
import { isQuoteStale } from "@/lib/quote";
import { EXPIRY_PRESETS, MAX_MEMO_LENGTH } from "@/lib/request/types";
import { DEFAULT_TOKEN, isValidAddress } from "@/lib/strk20/constants";

/** One row of the form. Amounts stay strings until the moment they're parsed. */
interface DraftShare {
  label: string;
  amount: string;
  memo: string;
}

/**
 * How the amounts are arrived at.
 *
 * All three modes end in the same `BillShare[]`; the difference is only who
 * does the arithmetic. Splitting evenly and reading a receipt both go through
 * `allocate`, so the shares add back up to the total exactly — the organiser is
 * never left carrying a rounding gap.
 */
type Mode = "each" | "even" | "nota";

/** What we know about whatever was typed into "Paid to". Same shape as the request form. */
type Resolution =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "ok"; address: string; name: string | null }
  | { state: "error"; message: string };

interface CreatedBill {
  path: string;
  url: string;
  shares: number;
  total: string;
  /** The encoded payload, kept so a short link can be minted from it. */
  payload: string;
  expiresAt?: number;
}

const BLANK: DraftShare = { label: "", amount: "", memo: "" };

/**
 * @param canShorten whether this deployment has a store to park an encrypted
 * bill in. When it doesn't, the option isn't offered at all — a short link
 * without durable storage is a link that dies on the next request, and
 * offering it and failing later is worse than not offering it.
 */
export default function CreateBillForm({
  canShorten,
  canScan,
}: {
  canShorten: boolean;
  /** Whether this deployment has an API key for reading receipts. */
  canScan: boolean;
}) {
  const { address, isConnected } = useWallet();

  const [recipient, setRecipient] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<Mode>("each");
  // What a scan produced: one amount per row, plus the rate it was converted
  // at. Held apart from the rows so the rows stay the single description of
  // *who* is on the bill and this stays the description of how much.
  const [scanned, setScanned] = useState<ScanResult | null>(null);
  const [total, setTotal] = useState("");
  const [rows, setRows] = useState<DraftShare[]>([{ ...BLANK }, { ...BLANK }]);
  const [expiryIndex, setExpiryIndex] = useState(2); // 7 days
  const [error, setError] = useState("");
  const [created, setCreated] = useState<CreatedBill | null>(null);
  const [copied, setCopied] = useState<"full" | "short" | null>(null);

  // The short link, once someone asks for one. Deliberately not minted up
  // front: it costs a write to a store, and most bills never need it.
  const [shortLink, setShortLink] = useState("");
  const [shortening, setShortening] = useState(false);
  const [shortError, setShortError] = useState("");

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

  // Resolve what was typed, debounced — the same lookup the single-request form
  // does, and for the same reason: the organiser should see where the money is
  // going before they hand twenty people a link to it.
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
      } catch (failure) {
        if ((failure as Error)?.name !== "AbortError") {
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

  function updateRow(index: number, patch: Partial<DraftShare>) {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row))
    );
  }

  /**
   * Adding or removing a person invalidates a scan.
   *
   * The scan produced one amount per row, matched by position. Change the
   * roster and those positions mean something else — so the result is dropped
   * rather than silently re-pointed at the wrong people.
   */
  function addRow() {
    setRows((current) =>
      current.length >= MAX_SHARES ? current : [...current, { ...BLANK }]
    );
    setScanned(null);
  }

  function removeRow(index: number) {
    setRows((current) =>
      current.length <= MIN_SHARES
        ? current
        : current.filter((_, i) => i !== index)
    );
    setScanned(null);
  }

  /**
   * Turn the draft into shares, or explain why it can't be.
   *
   * Every failure here is a typo the organiser can still fix. Once a bill is
   * encoded it is a URL that has been sent to people, so this is the last point
   * at which a wrong number costs nothing.
   */
  function buildShares(): BillShare[] {
    const labels = rows.map((row) => row.label.trim());
    if (labels.some((label) => label === "")) {
      throw new Error("Give every line a name — that's how each person knows which link is theirs.");
    }
    if (labels.some((label) => label.length > MAX_LABEL_LENGTH)) {
      throw new Error(`Names can be at most ${MAX_LABEL_LENGTH} characters.`);
    }

    const memos = rows.map((row) => row.memo.trim() || undefined);

    if (mode === "nota") {
      if (!scanned) {
        throw new Error("Assign the receipt's lines to people first.");
      }
      // Positional, so a mismatch means the roster moved under the result. It
      // can't be reconciled here — the amounts belong to whoever was in those
      // positions when the scan was applied.
      if (scanned.amounts.length !== rows.length) {
        throw new Error("The people on this bill changed. Assign the receipt again.");
      }
      // A rate locked into a link can't be taken back, so a stale one is
      // refused rather than used. See `MAX_QUOTE_AGE_SECONDS`.
      if (isQuoteStale(scanned.quote)) {
        throw new Error(
          "That exchange rate is more than ten minutes old. Refresh it before minting the links."
        );
      }
      return labels.map((label, index) => {
        const amount = BigInt(scanned.amounts[index]);
        if (amount <= 0n) {
          throw new Error(`${label}'s share came out as nothing — check the assignments.`);
        }
        return { label, amount, memo: memos[index] };
      });
    }

    if (mode === "even") {
      const amount = parseUnits(total, DEFAULT_TOKEN.decimals);
      if (amount <= 0n) {
        throw new Error("Enter a total greater than zero.");
      }
      // Largest-remainder, so the parts add up to the total exactly.
      const portions = allocateEvenly(amount, rows.length);
      // A total smaller than the number of people leaves someone a share of
      // zero, and a zero-amount request is refused by the decoder — which would
      // mean minting links that are already dead, including the organiser's own
      // bill page. The "each" branch checks this per share; this branch has to
      // check what the split produced.
      if (portions.some((portion) => portion <= 0n)) {
        throw new Error(
          `${formatDisplay(amount, DEFAULT_TOKEN.decimals)} ${DEFAULT_TOKEN.symbol} doesn't divide between ${rows.length} people — someone's share would be nothing.`
        );
      }
      return labels.map((label, index) => ({
        label,
        amount: portions[index],
        memo: memos[index],
      }));
    }

    return labels.map((label, index) => {
      const amount = parseUnits(rows[index].amount, DEFAULT_TOKEN.decimals);
      if (amount <= 0n) {
        throw new Error(`${label}'s share has to be greater than zero.`);
      }
      return { label, amount, memo: memos[index] };
    });
  }

  function handleSubmit(event: React.FormEvent) {
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
    if (resolution.state !== "ok") {
      setError("Still checking that address — give it a second.");
      return;
    }

    let shares: BillShare[];
    try {
      shares = buildShares();
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "Those amounts aren't valid."
      );
      return;
    }

    const createdAt = Math.floor(Date.now() / 1000);
    const expiresIn = EXPIRY_PRESETS[expiryIndex].seconds;
    const typedAName = isStarkDomain(recipient.toLowerCase());

    const bill: SplitBill = {
      id: newRequestId(),
      // The resolved address is what gets paid, so a name transferred later
      // can't redirect links that are already in people's chats.
      recipient: resolution.address,
      recipientName: typedAName ? recipient.toLowerCase() : undefined,
      token: DEFAULT_TOKEN.address,
      title: title.trim() || undefined,
      shares,
      createdAt,
      expiresAt: expiresIn === null ? undefined : createdAt + expiresIn,
      // Display context, carried so the payer can be shown roughly what their
      // share was in the money they know. The binding number stays the STRK.
      quote: mode === "nota" ? scanned?.quote : undefined,
    };

    const payload = encodeBill(bill);
    const path = billPath(payload);
    const url = `${window.location.origin}${path}`;
    const sum = shares.reduce((running, share) => running + share.amount, 0n);

    setCreated({
      path,
      url,
      payload,
      expiresAt: bill.expiresAt,
      shares: shares.length,
      total: formatDisplay(sum, DEFAULT_TOKEN.decimals),
    });
    setCopied(null);
    setShortLink("");
    setShortError("");

    // Remembered on this device only, like every other link this app mints.
    saveToHistory({
      id: bill.id,
      path,
      url,
      recipient: bill.recipient,
      recipientName: bill.recipientName,
      token: bill.token,
      amount: sum.toString(),
      memo: bill.title,
      createdAt,
      expiresAt: bill.expiresAt,
      shares: shares.length,
    });
  }

  /**
   * Mint the short link: encrypt here, store the ciphertext, keep the key.
   *
   * The order matters. The key is generated in this browser and exported only
   * into the fragment of the returned URL; the POST carries the ciphertext and
   * the IV and nothing else. There is no point in this function at which the
   * server could have learned what the bill says.
   */
  async function shorten(bill: CreatedBill) {
    setShortError("");
    setShortening(true);
    try {
      const key = await generateBillKey();
      const sealed = await encryptBill(bill.payload, key);

      const response = await fetch("/api/bills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...sealed, expiresAt: bill.expiresAt }),
      });
      const body = await response.json();
      if (!response.ok) {
        setShortError(body.error ?? "The short link couldn't be created.");
        return;
      }

      setShortLink(
        `${window.location.origin}${body.path}#${await exportBillKey(key)}`
      );
    } catch (failure) {
      setShortError(
        failure instanceof BillCryptoError
          ? failure.message
          : "Couldn't reach the server. The full link above works regardless."
      );
    } finally {
      setShortening(false);
    }
  }

  if (created) {
    return (
      <section className={CARD_SURFACE}>
        <h2 className="display text-lg">Your bill is ready</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {created.shares} lines, {created.total} {DEFAULT_TOKEN.symbol} in
          total. Open it to copy each person's link, or paste the whole list
          into your group chat at once.
        </p>

        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <input
            readOnly
            value={created.url}
            onFocus={(event) => event.currentTarget.select()}
            className={`${INSET_SURFACE} min-w-0 flex-1 px-3 py-2.5 font-mono text-xs`}
          />
          <Button
            variant="primary"
            onClick={() => {
              void navigator.clipboard.writeText(created.url);
              setCopied("full");
            }}
          >
            {copied === "full" ? "Copied" : "Copy"}
          </Button>
        </div>

        <p className="mt-2.5 text-xs leading-relaxed text-muted">
          This link is the bill — every name and amount is inside it, and no
          server has a copy. Keep it somewhere you'll find it again, and don't
          post it where the people who owe you can read each other's shares.
        </p>

        {canShorten ? (
          <div className={`${INSET_SURFACE} mt-5 p-4`}>
            <p className="display text-xs tracking-wide text-muted uppercase">
              Shorter link
            </p>

            {shortLink === "" ? (
              <>
                <p className="mt-2.5 text-xs leading-relaxed text-muted">
                  {created.shares > 8
                    ? "A bill this long makes a link some chat apps will cut in half."
                    : "Some chat apps cut long links."}{" "}
                  Whisper Pay can encrypt this bill in your browser and store the
                  ciphertext, leaving a short link with the key after the{" "}
                  <code className="font-mono">#</code> — the part browsers never
                  send to a server.
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted">
                  <strong className="font-medium text-foreground">
                    The trade:
                  </strong>{" "}
                  a short link expires
                  {created.expiresAt === undefined
                    ? " after 30 days"
                    : " with the bill, or after 30 days, whichever is sooner"}
                  , and dies if the store is ever lost. The full link above
                  can't — which is why it stays the one that matters.
                </p>
                <Button
                  size="sm"
                  className="mt-3"
                  disabled={shortening}
                  onClick={() => void shorten(created)}
                >
                  {shortening ? "Encrypting…" : "Make a short link too"}
                </Button>
              </>
            ) : (
              <>
                <div className="mt-2.5 flex flex-col gap-2 sm:flex-row">
                  <input
                    readOnly
                    value={shortLink}
                    onFocus={(event) => event.currentTarget.select()}
                    className="min-w-0 flex-1 border-2 border-hairline bg-surface px-3 py-2 font-mono text-xs"
                  />
                  <Button
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(shortLink);
                      setCopied("short");
                    }}
                  >
                    {copied === "short" ? "Copied" : "Copy"}
                  </Button>
                </div>
                <p className="mt-2.5 text-xs leading-relaxed text-muted">
                  Copy the whole thing, <code className="font-mono">#</code> and
                  all — without the part after the hash there is no key, and the
                  bill can't be opened by anyone, including you.
                </p>
              </>
            )}

            {shortError ? (
              <p className="mt-3 text-xs text-danger">{shortError}</p>
            ) : null}
          </div>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-3">
          <Link href={created.path} className={buttonClass("secondary")}>
            Open the bill
          </Link>
          <Button
            onClick={() => {
              setCreated(null);
              setRows([{ ...BLANK }, { ...BLANK }]);
              setTotal("");
              setTitle("");
              setShortLink("");
              setShortError("");
              // `scanned` has to go with the rows it was computed from.
              // Leaving it behind meant the next bill could be minted carrying
              // the previous receipt's per-person amounts, with nothing on
              // screen saying so — `addRow` and `removeRow` clear it for
              // exactly this reason, and this path is the one that resets more
              // than either of them.
              setMode("each");
              setScanned(null);
              setError("");
            }}
          >
            Build another
          </Button>
        </div>
      </section>
    );
  }

  return (
    <form onSubmit={handleSubmit} className={CARD_SURFACE}>
      <h2 className="display text-lg">Split a bill</h2>
      <p className="mt-2 text-sm leading-relaxed text-muted">
        One line per person. Each gets an ordinary payment link of their own, and
        you get one page showing who has paid.
      </p>

      <div className="mt-6 space-y-5">
        <Field
          label="Paid to"
          hint="Everyone on this bill pays the same address — yours."
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

        <Field label="What for" hint="Shown at the top of the bill page. Optional.">
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={MAX_TITLE_LENGTH}
            placeholder="Saturday dinner"
            className={`${INSET_SURFACE} w-full px-3 py-2.5 text-sm outline-none focus:border-accent`}
          />
        </Field>

        <Field label="Amounts">
          <div className="flex flex-wrap gap-2">
            <Choice selected={mode === "each"} onClick={() => setMode("each")}>
              Enter each share
            </Choice>
            <Choice selected={mode === "even"} onClick={() => setMode("even")}>
              Split a total evenly
            </Choice>
            {/*
              Offered only where there is a key to read a receipt with. A mode
              that fails the moment it is used is worse than one that isn't
              there — the same rule the short link follows.
            */}
            {canScan ? (
              <Choice selected={mode === "nota"} onClick={() => setMode("nota")}>
                From a receipt
              </Choice>
            ) : null}
          </div>

          {mode === "even" ? (
            <div className={`${INSET_SURFACE} mt-3 flex items-center gap-2 px-3 py-2.5 focus-within:border-accent`}>
              <input
                aria-label="Bill total"
                value={total}
                onChange={(event) => setTotal(event.target.value)}
                inputMode="decimal"
                placeholder="0.0"
                className="tabular min-w-0 flex-1 bg-transparent text-2xl font-medium outline-none"
              />
              <span className="display shrink-0 bg-surface-raised px-2.5 py-1 text-xs">
                {DEFAULT_TOKEN.symbol}
              </span>
            </div>
          ) : null}

          {mode === "nota" ? (
            <div className="mt-3">
              {scanned ? (
                <div className={`${INSET_SURFACE} p-4`}>
                  <p className="display text-sm">Amounts taken from the receipt</p>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted">
                    Each person's share is filled in below. Change anything and
                    scan again, or switch to entering the shares by hand.
                  </p>
                  <Button
                    size="sm"
                    className="mt-3"
                    onClick={() => setScanned(null)}
                  >
                    Scan a different receipt
                  </Button>
                </div>
              ) : (
                <ScanNota
                  people={rows.map((row) => row.label)}
                  onApply={(result) => {
                    setScanned(result);
                    setError("");
                    // The note can name people this form has never seen, so the
                    // rows are rewritten from the result rather than matched
                    // against it — `result.amounts[i]` is `result.names[i]`'s,
                    // and lining them up by position is what would break.
                    // Anything already typed for a name that survives is kept:
                    // a memo the organiser wrote is theirs.
                    setRows((current) =>
                      result.names.map((label) => {
                        const existing = current.find(
                          (row) =>
                            row.label.trim().toLowerCase() ===
                            label.trim().toLowerCase()
                        );
                        return { ...BLANK, ...existing, label };
                      })
                    );
                    // Offered, not imposed: a title the organiser already typed
                    // is theirs and stays.
                    if (title.trim() === "" && result.title) setTitle(result.title);
                  }}
                />
              )}
            </div>
          ) : null}
        </Field>

        <div className="space-y-2">
          {rows.map((row, index) => (
            <div key={index} className={`${INSET_SURFACE} flex flex-wrap gap-2 p-2.5`}>
              <input
                aria-label={`Name for line ${index + 1}`}
                value={row.label}
                onChange={(event) => updateRow(index, { label: event.target.value })}
                maxLength={MAX_LABEL_LENGTH}
                placeholder="Name"
                className="min-w-24 flex-1 border-2 border-hairline bg-surface px-2.5 py-2 text-sm outline-none focus:border-accent"
              />
              {mode === "each" ? (
                <input
                  aria-label={`Amount for line ${index + 1}`}
                  value={row.amount}
                  onChange={(event) => updateRow(index, { amount: event.target.value })}
                  inputMode="decimal"
                  placeholder="0.0"
                  className="tabular w-28 border-2 border-hairline bg-surface px-2.5 py-2 text-sm outline-none focus:border-accent"
                />
              ) : null}
              {mode === "nota" && scanned?.amounts[index] ? (
                <span className="tabular w-28 px-2.5 py-2 text-sm">
                  {formatDisplay(
                    BigInt(scanned.amounts[index]),
                    DEFAULT_TOKEN.decimals
                  )}{" "}
                  <span className="text-xs text-muted">{DEFAULT_TOKEN.symbol}</span>
                </span>
              ) : null}
              <input
                aria-label={`Note for line ${index + 1}`}
                value={row.memo}
                onChange={(event) => updateRow(index, { memo: event.target.value })}
                maxLength={MAX_MEMO_LENGTH}
                placeholder="What they had — optional"
                className="min-w-32 flex-1 border-2 border-hairline bg-surface px-2.5 py-2 text-sm outline-none focus:border-accent"
              />
              <Button
                size="sm"
                variant="ghost"
                title={`Remove line ${index + 1}`}
                disabled={rows.length <= MIN_SHARES}
                onClick={() => removeRow(index)}
              >
                ×
              </Button>
            </div>
          ))}

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={addRow} disabled={rows.length >= MAX_SHARES}>
              Add a person
            </Button>
            <span className="text-xs text-muted">
              {rows.length} of {MAX_SHARES}
              {rows.length >= MAX_SHARES
                ? " — past this the link stops fitting in a chat message"
                : ""}
            </span>
          </div>
        </div>

        <Field label="Links expire">
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
      </div>

      {error ? <p className="mt-5 text-sm text-danger">{error}</p> : null}

      <Button type="submit" variant="primary" size="lg" className="mt-6 w-full">
        Build the bill
      </Button>
    </form>
  );
}

/** Feedback under "Paid to" — a name shows its address, an address shows its name. */
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
