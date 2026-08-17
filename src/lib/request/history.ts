"use client";

/**
 * The requests this browser has created.
 *
 * Deliberately local. Since a request lives entirely in its link, the server
 * never needs a list of who asked whom for money — and keeping that list only
 * on the creator's device means there's no such list to leak or subpoena. The
 * cost is that history doesn't follow you between browsers, which is the right
 * trade for this app.
 */

import { isValidSchedule, type Schedule } from "./schedule";

const STORAGE_KEY = "whisperpay.requests.v1";

/** Plenty for a demo or a freelancer's month; keeps localStorage small. */
const MAX_ENTRIES = 200;

export interface HistoryEntry {
  id: string;
  path: string;
  url: string;
  recipient: string;
  /** `.stark` label the request was created against, when there was one. */
  recipientName?: string;
  token: string;
  /** Smallest-unit amount, as a decimal string. Per installment if recurring. */
  amount: string;
  memo?: string;
  createdAt: number;
  expiresAt?: number;
  /** Present for a recurring request. Entries created before M4 have none. */
  schedule?: Schedule;
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<HistoryEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.path === "string" &&
    typeof entry.recipient === "string" &&
    typeof entry.amount === "string"
  );
}

export function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isEntry)
      // A malformed schedule would render as "Invalid Date" forever; the rest
      // of the entry is still useful, so drop just the schedule.
      .map((entry) =>
        entry.schedule && !isValidSchedule(entry.schedule)
          ? { ...entry, schedule: undefined }
          : entry
      )
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export function saveToHistory(entry: HistoryEntry): void {
  if (typeof window === "undefined") return;
  try {
    const next = [entry, ...loadHistory().filter((e) => e.id !== entry.id)].slice(
      0,
      MAX_ENTRIES
    );
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* private browsing or a full quota — history is a convenience, not a need */
  }
}

export function removeFromHistory(id: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(loadHistory().filter((entry) => entry.id !== id))
    );
  } catch {
    /* ignore */
  }
}
