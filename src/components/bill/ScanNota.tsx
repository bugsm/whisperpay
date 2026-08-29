"use client";

import { useState } from "react";

import Button from "@/components/ui/Button";
import Notice from "@/components/ui/Notice";
import { INSET_SURFACE } from "@/components/ui/surfaces";
import { notaTotals, type ScannedNota } from "@/lib/ai/nota";
import { allocate } from "@/lib/bill/allocate";
import { MAX_SHARES, MIN_SHARES, type FiatQuote } from "@/lib/bill/types";
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

/** Matches the route's own cap, so a note is refused here rather than there. */
const MAX_NOTE_LENGTH = 2000;

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
  /**
   * The people these amounts belong to, in the same order.
   *
   * Carried rather than assumed, because the note can introduce names the form
   * has never seen. `amounts[i]` is `names[i]`'s, and the form rewrites its
   * rows to match rather than trying to line the two up by position.
   */
  names: string[];
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
  const [weights, setWeights] = useState<bigint[][]>([]);
  /**
   * The roster the note produced, or `null` when there was no note.
   *
   * A note names its own people — "udin - ayam" introduces udin whether or not
   * a row for him exists — so when there is one it *is* the roster, and the
   * form's rows are rewritten from it. Without one, the typed rows stay in
   * charge and this whole mechanism is invisible.
   */
  const [names, setNames] = useState<string[] | null>(null);
  const [note, setNote] = useState("");
  const [quote, setQuote] = useState<FiatQuote | null>(null);
  const [quoteError, setQuoteError] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const roster = names ?? people;

  async function handleFile(file: File) {
    setError("");
    setBusy(true);
    try {
      const image = await downscale(file);
      const diners = note.trim();
      const response = await fetch("/api/nota/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(diners === "" ? image : { ...image, diners }),
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

      const scannedNames = rosterFrom(nota.items);
      setNames(scannedNames);
      setWeights(gridFrom(nota.items, scannedNames ?? people));
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
  const grid = (draft?.items ?? []).map((_, i) => fit(weights[i], roster.length));

  function setRow(itemIndex: number, next: (row: bigint[]) => bigint[]) {
    // Refitted inside the updater rather than from `grid`, so two taps batched
    // into one render can't have the second overwrite the first.
    setWeights((current) =>
      (draft?.items ?? []).map((_, i) => {
        const row = fit(current[i], roster.length);
        return i === itemIndex ? next(row) : row;
      })
    );
  }

  /**
   * Tapping a name is on/off, even though the cell holds a count.
   *
   * The count comes from the note — "adi - es teh 2" is a weight of two — and a
   * tap can only clear it or set it back to one. That is the honest limit of a
   * chip: there is nowhere on it to say "three", and inventing a stepper would
   * put a second way to edit quantities next to the note that already does it
   * better. Turning someone off and on again resets them to one share, and the
   * chip shows the count so it is never a silent change.
   */
  function toggle(itemIndex: number, personIndex: number) {
    setRow(itemIndex, (row) =>
      row.map((share, p) => (p === personIndex ? (share > 0n ? 0n : 1n) : share))
    );
  }

  function everyone(itemIndex: number) {
    setRow(itemIndex, (row) => row.map((share) => (share > 0n ? share : 1n)));
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

    // The roster can come from the note, which never went through the form's
    // add/remove buttons and so was never held to their limits. Checked here,
    // where the message can name the note as the thing to change — `encodeBill`
    // would refuse the same bill later with nothing to act on.
    if (roster.length < MIN_SHARES) {
      setError(
        names === null
          ? `A bill needs at least ${MIN_SHARES} people.`
          : `Only ${roster.length === 1 ? `"${roster[0]}" was` : "nobody was"} named in the note. A bill needs at least ${MIN_SHARES} people — one person owing you is an ordinary payment request.`
      );
      return;
    }
    if (roster.length > MAX_SHARES) {
      setError(
        `That note names ${roster.length} people, and a bill carries at most ${MAX_SHARES}. Split it into two bills.`
      );
      return;
    }

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
      .filter(({ index }) => !grid[index]?.some((share) => share > 0n));
    if (unassigned.length > 0) {
      setError(
        `Nobody is down for ${unassigned
          .map(({ item, index }) => `"${item.name || `line ${index + 1}`}"`)
          .join(", ")}. Tap a name on each line, or Everyone.`
      );
      return;
    }

    // Each line split among the people who had it, in proportion to how many
    // of it each had. `allocate` takes the weights directly, so "adi - es teh
    // 2" against "udin - es teh 1" divides the line two-to-one without any
    // arithmetic happening here — and without the model ever producing a
    // figure someone is asked to pay.
    const perPerson = roster.map(() => 0n);
    items.forEach((amount, itemIndex) => {
      allocate(amount, grid[itemIndex]).forEach((share, p) => {
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
      names: roster,
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

        <label className="mt-3 block">
          <span className="display mb-1 block text-xs tracking-wide text-muted uppercase">
            Who had what (optional)
          </span>
          <textarea
            value={note}
            rows={3}
            disabled={busy}
            placeholder={"bugsm - chicken, iced tea\neli - chicken 1, iced tea 2"}
            onChange={(event) => setNote(event.target.value)}
            maxLength={MAX_NOTE_LENGTH}
            className="w-full resize-y border-2 border-hairline bg-background px-2 py-1.5 text-sm leading-relaxed outline-none focus:border-accent"
          />
          <span className="mt-1.5 block text-xs leading-relaxed text-muted">
            Write it however you'd say it. Names, then what they had — a number
            after a dish means how many were theirs. The lines get matched to
            the receipt and everyone's share is worked out, so all that's left
            is to check it. Leave this empty to tap the names instead.
          </span>
        </label>

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
            setWeights([]);
            setNames(null);
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
              {roster.map((person, personIndex) => {
                const share = grid[index]?.[personIndex] ?? 0n;
                return (
                  <button
                    key={personIndex}
                    type="button"
                    aria-pressed={share > 0n}
                    onClick={() => toggle(index, personIndex)}
                    className={`pixel-press display border-2 px-2 py-1 text-xs ${
                      share > 0n
                        ? "border-accent bg-accent-soft text-foreground"
                        : "border-hairline text-muted hover:border-accent hover:text-foreground"
                    }`}
                  >
                    {person.trim() || `#${personIndex + 1}`}
                    {/* Shown only when it isn't one, so a plain shared line
                        stays a plain chip and a count is always a signal. */}
                    {share > 1n ? (
                      <span className="ml-1 text-accent">×{share.toString()}</span>
                    ) : null}
                  </button>
                );
              })}
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
          — the {quote.currency} figure is context, and it doesn't follow the
          market after the link is made.
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
          {DEFAULT_TOKEN.symbol} across {roster.length} people.
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
function fit(row: bigint[] | undefined, length: number): bigint[] {
  return Array.from({ length }, (_, i) => row?.[i] ?? 0n);
}

/**
 * The people the note named, in the order they were first mentioned.
 *
 * First mention rather than alphabetical, because that is the order the
 * organiser typed and the order the rows will appear in — a list that comes
 * back rearranged reads as though something was misunderstood.
 *
 * `null` when no line carries a share, which is how "there was no note" is
 * told apart from "the note named nobody this receipt has": the first leaves
 * the form's own rows in charge, the second is a scan worth redoing.
 */
function rosterFrom(items: ScannedNota["items"]): string[] | null {
  const seen = new Map<string, string>();
  for (const item of items) {
    for (const share of item.shares ?? []) {
      const key = share.name.trim().toLowerCase();
      if (key !== "" && !seen.has(key)) seen.set(key, share.name.trim());
    }
  }
  return seen.size === 0 ? null : [...seen.values()];
}

/**
 * The assignment grid the scan came back with.
 *
 * Names are matched case-insensitively against the roster: the model is told
 * to spell each person one way throughout, and this is what happens when it
 * doesn't quite. A name that matches nothing is dropped rather than appended —
 * the roster came from these same shares, so it can only be one the organiser
 * removed, and re-adding it here would undo their edit.
 */
function gridFrom(items: ScannedNota["items"], roster: string[]): bigint[][] {
  const index = new Map(roster.map((name, i) => [name.trim().toLowerCase(), i]));

  return items.map((item) => {
    const row = Array.from({ length: roster.length }, () => 0n);
    for (const share of item.shares ?? []) {
      const at = index.get(share.name.trim().toLowerCase());
      if (at !== undefined) row[at] = BigInt(share.quantity);
    }
    return row;
  });
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
