"use client";

import { useState } from "react";

import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import { INSET_SURFACE } from "@/components/ui/surfaces";
import { notaTotals, type ScannedNota } from "@/lib/ai/nota";
import { allocate } from "@/lib/bill/allocate";
import type { FiatQuote } from "@/lib/bill/types";
import {
  fiatToTokenUnits,
  findCurrency,
  formatFiat,
  isQuoteStale,
  quoteAgeSeconds,
} from "@/lib/quote";
import { formatDisplay } from "@/lib/amount";
import { DEFAULT_TOKEN } from "@/lib/strk20/constants";

/**
 * Photograph a receipt, correct what was read, and say who had what.
 *
 * Three things about this flow are deliberate and worth stating where the code
 * is, because each of them is a place it would be easy to do the convenient
 * thing instead:
 *
 * **Every number stays editable.** The scan fills the fields in; it does not
 * lock them. A misread line is expected, not exceptional.
 *
 * **A total that disagrees is shown, not fixed.** The organiser is holding the
 * paper and can see which of the two numbers is wrong. Quietly adjusting the
 * lines to match the printed total would hide the one signal that the scan went
 * wrong.
 *
 * **The conversion happens once, on the whole bill.** Converting each person
 * separately would floor each of them down and leave the organiser carrying the
 * remainder — so the total is converted and then split with `allocate`, which
 * is exact. See `@/lib/quote`.
 */

/** What the browser sends: a downscaled photo, small enough to post. */
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 0.85;

interface Draft {
  merchant?: string;
  currency: string;
  items: { name: string; quantity: number; amount: string }[];
  tax: string;
  service: string;
  discount: string;
  total: string;
}

export interface ScanResult {
  /** Per person, in the token's smallest unit, as decimal strings. */
  amounts: string[];
  /** The rate this was converted at, to travel in the bill payload. */
  quote: FiatQuote;
  /** The merchant, offered as a title. */
  title?: string;
}

export default function ScanNota({
  people,
  onApply,
}: {
  /** The names currently typed into the form, in row order. */
  people: string[];
  onApply: (result: ScanResult) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [assigned, setAssigned] = useState<boolean[][]>([]);
  const [quote, setQuote] = useState<FiatQuote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleFile(file: File) {
    setError("");
    setBusy(true);
    try {
      const image = await downscale(file);
      const response = await fetch("/api/nota/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(image),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "The scan failed.");
        return;
      }

      const nota = body.nota as ScannedNota;
      setDraft({
        merchant: nota.merchant,
        currency: nota.currency,
        items: nota.items.map((item) => ({ ...item })),
        tax: nota.tax ?? "",
        service: nota.service ?? "",
        discount: nota.discount ?? "",
        total: nota.total ?? "",
      });
      setAssigned(nota.items.map(() => people.map(() => false)));
      void loadQuote(nota.currency);
    } catch {
      setError("Couldn't read that image in this browser. Try a different photo.");
    } finally {
      setBusy(false);
    }
  }

  async function loadQuote(currency: string) {
    setQuoteError("");
    try {
      const response = await fetch(`/api/quote?currency=${encodeURIComponent(currency)}`);
      const body = await response.json();
      if (!response.ok) {
        setQuote(null);
        setQuoteError(body.error ?? "No exchange rate is available right now.");
        return;
      }
      setQuote(body.quote as FiatQuote);
    } catch {
      setQuote(null);
      setQuoteError("Couldn't reach the price source.");
    }
  }

  function updateItem(index: number, patch: Partial<Draft["items"][number]>) {
    setDraft((current) =>
      current === null
        ? current
        : {
            ...current,
            items: current.items.map((item, i) =>
              i === index ? { ...item, ...patch } : item
            ),
          }
    );
  }

  /**
   * The assignment grid, sized to the people who are on the form *now*.
   *
   * `assigned` is built once, at scan time, from the names that existed then —
   * and the organiser can add a name afterwards without the draft being thrown
   * away, because a scan costs an API call. `map` cannot lengthen an array, so
   * a grid left at its original width gave that person a column of buttons that
   * flipped nothing and an error on "Use these amounts" they had no way to act
   * on. Every read and every write goes through here instead.
   *
   * Removing a name is the case padding cannot repair: the rows are keyed by
   * position, so everyone after the removed name shifts down a column and their
   * ticks move with it. Nothing here can tell that apart from a deliberate
   * change, which is why the form clears a scan whenever a row is added or
   * removed.
   */
  const grid = (draft?.items ?? []).map((_, i) => fit(assigned[i], people.length));

  function setRow(itemIndex: number, next: (row: boolean[]) => boolean[]) {
    // Refitted inside the updater rather than from `grid`, so two taps batched
    // into one render can't have the second overwrite the first.
    setAssigned((current) =>
      (draft?.items ?? []).map((_, i) => {
        const row = fit(current[i], people.length);
        return i === itemIndex ? next(row) : row;
      })
    );
  }

  function toggle(itemIndex: number, personIndex: number) {
    setRow(itemIndex, (row) => row.map((on, p) => (p === personIndex ? !on : on)));
  }

  function everyone(itemIndex: number) {
    setRow(itemIndex, (row) => row.map(() => true));
  }

  /**
   * Turn the draft plus the assignments into one amount per person.
   *
   * The order of operations is the whole point — see the module comment. Items
   * split among their eaters, tax and service pro-rated by what each person
   * ate, and only then a single conversion of the total.
   */
  function apply() {
    if (!draft || !quote) return;
    setError("");

    let items: bigint[];
    try {
      items = draft.items.map((item, index) => {
        if (!/^\d+$/.test(item.amount.trim())) {
          throw new Error(`"${item.name || `line ${index + 1}`}" needs a plain number.`);
        }
        return BigInt(item.amount.trim());
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Check the amounts.");
      return;
    }

    const unassigned = draft.items
      .map((item, index) => ({ item, index }))
      .filter(({ index }) => !grid[index]?.some(Boolean));
    if (unassigned.length > 0) {
      setError(
        `Nobody is down for ${unassigned
          .map(({ item, index }) => `"${item.name || `line ${index + 1}`}"`)
          .join(", ")}. Tap a name on each line, or Everyone.`
      );
      return;
    }

    // Each line split among the people who had it.
    const perPerson = people.map(() => 0n);
    items.forEach((amount, itemIndex) => {
      const weights = people.map((_, p) => (grid[itemIndex][p] ? 1n : 0n));
      allocate(amount, weights).forEach((share, p) => {
        perPerson[p] += share;
      });
    });

    if (perPerson.some((amount) => amount <= 0n)) {
      setError(
        "Everyone on the bill needs at least one line — a share of nothing can't be a payment link."
      );
      return;
    }

    // Tax and service pro-rated by what each person ate, discount likewise.
    // Each of these allocations sums exactly to the figure it splits, so the
    // people's totals still add up to the receipt's.
    const extras: [bigint, 1n | -1n][] = [
      [optional(draft.tax), 1n],
      [optional(draft.service), 1n],
      [optional(draft.discount), -1n],
    ];
    const subtotals = [...perPerson];
    for (const [amount, sign] of extras) {
      if (amount === 0n) continue;
      allocate(amount, subtotals).forEach((share, p) => {
        perPerson[p] += sign * share;
      });
    }

    if (perPerson.some((amount) => amount <= 0n)) {
      setError("That discount leaves someone owing nothing or less. Adjust the lines.");
      return;
    }

    const totalFiat = perPerson.reduce((sum, amount) => sum + amount, 0n);
    // One conversion, then split — never one conversion per person.
    const totalUnits = fiatToTokenUnits(totalFiat, quote, DEFAULT_TOKEN.decimals);
    if (totalUnits <= 0n) {
      setError("That total converts to nothing at the current rate.");
      return;
    }
    const units = allocate(totalUnits, perPerson);

    onApply({
      amounts: units.map((amount) => amount.toString()),
      quote,
      title: draft.merchant,
    });
  }

  if (!draft) {
    return (
      <div className={`${INSET_SURFACE} p-4`}>
        <p className="text-xs leading-relaxed text-muted">
          Photograph the receipt and Whisper Pay will read the lines off it. You
          check every number before anything is minted — the photo is sent to be
          read and never stored.
        </p>
        <label className="mt-3 inline-block">
          <span className="sr-only">Receipt photo</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFile(file);
            }}
            className="block w-full text-xs file:mr-3 file:border-2 file:border-hairline file:bg-surface-raised file:px-3 file:py-2 file:text-xs file:text-foreground"
          />
        </label>
        {busy ? (
          <p className="mt-2.5 text-xs text-muted">Reading the receipt…</p>
        ) : null}
        {error ? <p className="mt-2.5 text-xs text-danger">{error}</p> : null}
      </div>
    );
  }

  const currency = findCurrency(draft.currency);
  const totals = notaTotals({
    currency: draft.currency,
    items: draft.items.map((item) => ({
      ...item,
      amount: /^\d+$/.test(item.amount.trim()) ? item.amount.trim() : "0",
    })),
    tax: digits(draft.tax),
    service: digits(draft.service),
    discount: digits(draft.discount),
    total: digits(draft.total),
  });

  return (
    <div className={`${INSET_SURFACE} space-y-4 p-4`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="display text-sm">{draft.merchant ?? "Scanned receipt"}</p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraft(null);
            setAssigned([]);
            setError("");
          }}
        >
          Start over
        </Button>
      </div>

      <p className="text-xs leading-relaxed text-muted">
        Every figure below is editable, and should be checked — a receipt read
        from a photo is a draft. Tap the names on each line to say who had it.
      </p>

      <ul className="space-y-2">
        {draft.items.map((item, index) => (
          <li key={index} className="border-2 border-hairline bg-surface p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label={`Item ${index + 1} name`}
                value={item.name}
                onChange={(event) => updateItem(index, { name: event.target.value })}
                className="min-w-32 flex-1 border-2 border-hairline bg-background px-2 py-1.5 text-sm outline-none focus:border-accent"
              />
              <span className="text-xs text-muted">×{item.quantity}</span>
              <input
                aria-label={`Item ${index + 1} amount`}
                value={item.amount}
                inputMode="numeric"
                onChange={(event) => updateItem(index, { amount: event.target.value })}
                className={`tabular w-28 border-2 bg-background px-2 py-1.5 text-sm outline-none focus:border-accent ${
                  /^\d+$/.test(item.amount.trim())
                    ? "border-hairline"
                    : "border-danger"
                }`}
              />
            </div>

            <div className="mt-2 flex flex-wrap gap-1.5">
              {people.map((person, personIndex) => (
                <button
                  key={personIndex}
                  type="button"
                  aria-pressed={grid[index]?.[personIndex] ?? false}
                  onClick={() => toggle(index, personIndex)}
                  className={`pixel-press display border-2 px-2 py-1 text-xs ${
                    grid[index]?.[personIndex]
                      ? "border-accent bg-accent-soft text-foreground"
                      : "border-hairline text-muted hover:border-accent hover:text-foreground"
                  }`}
                >
                  {person.trim() || `#${personIndex + 1}`}
                </button>
              ))}
              <button
                type="button"
                onClick={() => everyone(index)}
                className="display border-2 border-hairline px-2 py-1 text-xs text-muted hover:border-accent hover:text-foreground"
              >
                Everyone
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="grid gap-2 sm:grid-cols-3">
        {(["tax", "service", "discount"] as const).map((field) => (
          <label key={field} className="block">
            <span className="display mb-1 block text-xs tracking-wide text-muted uppercase">
              {field}
            </span>
            <input
              value={draft[field]}
              inputMode="numeric"
              placeholder="0"
              onChange={(event) =>
                setDraft((current) =>
                  current === null
                    ? current
                    : { ...current, [field]: event.target.value }
                )
              }
              className="tabular w-full border-2 border-hairline bg-surface px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
          </label>
        ))}
      </div>

      <dl className="space-y-1 border-t-2 border-hairline pt-3 text-xs">
        <div className="flex justify-between">
          <dt className="text-muted">Lines add up to</dt>
          <dd className="tabular">{formatFiat(totals.computed, draft.currency)}</dd>
        </div>
        {totals.printed !== undefined ? (
          <div className="flex justify-between">
            <dt className="text-muted">Receipt says</dt>
            <dd className="tabular">{formatFiat(totals.printed, draft.currency)}</dd>
          </div>
        ) : null}
      </dl>

      {totals.difference !== undefined && totals.difference !== 0n ? (
        <Notice tone="warn" title="The lines don't match the printed total">
          Off by {formatFiat(abs(totals.difference), draft.currency)}. Something
          was misread, or the receipt has a line that wasn't picked up — check it
          against the paper and fix the number. Nothing here will adjust it for
          you.
        </Notice>
      ) : null}

      {/*
        A discount larger than everything it is deducted from. Worth its own
        sentence rather than a silent absence: `fiatToTokenUnits` refuses a
        negative amount, so the conversion line below simply disappears, and
        without this the organiser would be looking at a bill that quietly
        stopped telling them what it came to.
      */}
      {totals.computed <= 0n ? (
        <Notice tone="warn" title="The discount is bigger than the bill">
          These lines come to {formatFiat(totals.computed, draft.currency)},
          which is not something anyone can be asked to pay. A receipt usually
          prints a discount as a deduction from the subtotal — check that figure
          against the paper.
        </Notice>
      ) : null}

      {!currency ? (
        <Notice tone="warn" title={`No rate for ${draft.currency}`}>
          Whisper Pay can't convert this currency, so these amounts can't become
          STRK automatically. Switch to entering each share by hand.
        </Notice>
      ) : quote ? (
        <p className="text-xs leading-relaxed text-muted">
          Converting at {formatFiat(BigInt(Math.round(Number(quote.rate))), quote.currency)}{" "}
          per {DEFAULT_TOKEN.symbol}, read {Math.max(0, quoteAgeSeconds(quote))}s
          ago.{" "}
          <strong className="font-medium text-foreground">
            What the links ask for is {DEFAULT_TOKEN.symbol}
          </strong>{" "}
          — the rupiah figure is context, and it doesn't follow the market after
          the link is made.
          {isQuoteStale(quote) ? (
            <>
              {" "}
              This rate is stale now.{" "}
              <button
                type="button"
                onClick={() => void loadQuote(draft.currency)}
                className="text-accent underline underline-offset-4"
              >
                Refresh it
              </button>
              .
            </>
          ) : null}
        </p>
      ) : (
        <Notice tone="warn" title="No exchange rate">
          {quoteError || "The price source didn't answer."} You can still build
          the bill by entering each share in {DEFAULT_TOKEN.symbol} by hand.
        </Notice>
      )}

      {error ? <p className="text-xs text-danger">{error}</p> : null}

      <Button
        variant="primary"
        disabled={!quote || isQuoteStale(quote)}
        onClick={apply}
      >
        Use these amounts
      </Button>
      {quote && !isQuoteStale(quote) && totals.computed > 0n ? (
        <p className="text-xs text-muted">
          ≈ {formatDisplay(fiatToTokenUnits(totals.computed, quote, DEFAULT_TOKEN.decimals), DEFAULT_TOKEN.decimals)}{" "}
          {DEFAULT_TOKEN.symbol} across {people.length} people.
        </p>
      ) : null}
    </div>
  );
}

/**
 * One of these fields as `notaTotals` needs it, or nothing at all.
 *
 * `notaTotals` takes a `ScannedNota` — something that has already been through
 * `parseNota` — and calls `BigInt` on these fields directly. What is in state
 * here is an input the organiser is still typing into, where `12.500` is what
 * an Indonesian receipt actually prints: `BigInt("12.500")` throws a
 * `SyntaxError`, and thrown from the render body it takes the page with it.
 * Anything but digits is withheld rather than handed over.
 */
function digits(value: string): string | undefined {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : undefined;
}

/** The same fields for arithmetic, where absent means zero rather than nothing. */
function optional(value: string): bigint {
  return BigInt(digits(value) ?? 0);
}

/** A row padded or trimmed to one cell per person, so `map` is never short. */
function fit(row: boolean[] | undefined, length: number): boolean[] {
  return Array.from({ length }, (_, i) => row?.[i] ?? false);
}

function abs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Shrink a phone photo before it is posted.
 *
 * A modern camera produces four megabytes of receipt, which is more than a
 * serverless request body may carry and far more detail than reading printed
 * text needs. 1600px on the long edge keeps the digits legible and lands a
 * typical receipt in a few hundred kilobytes.
 */
async function downscale(file: File): Promise<{ image: string; mediaType: string }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no 2d context");
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  const dataUrl = canvas.toDataURL("image/jpeg", JPEG_QUALITY);
  return { image: dataUrl.split(",")[1], mediaType: "image/jpeg" };
}
