import "server-only";

import { restCredentials } from "./rest";

/**
 * A fixed-window rate limit, for the one endpoint here that costs money to
 * answer.
 *
 * Receipt scanning has no authentication in front of it — it can't, since the
 * whole app works without accounts — and every call bills a model. So the limit
 * is part of the endpoint rather than a hardening pass for later.
 *
 * Fixed window, not a sliding one: a window boundary lets someone burst twice
 * the limit across it, which for an endpoint measured in single-digit calls per
 * ten minutes is a rounding error next to the complexity of doing it properly.
 * `INCR` plus `EXPIRE` is two round trips and no Lua.
 *
 * Without a store this falls back to a per-process counter. That is weaker on
 * serverless, where each instance counts separately — but it is the difference
 * between a bounded and an unbounded endpoint, and the alternative (refusing to
 * scan at all without Redis) would switch the feature off in local development.
 */
export interface RateLimitResult {
  ok: boolean;
  /** How many are left in this window, floored at zero. */
  remaining: number;
  /** Seconds until the window rolls over. */
  resetIn: number;
}

const KEY_PREFIX = "whisperpay:rl:";

/**
 * Who is asking, as far as a proxy will say.
 *
 * `x-forwarded-for` is a list; the client is the first entry. It is trivially
 * spoofable by anyone talking to this app directly, and behind Vercel's proxy
 * the leftmost entry is the real one — so this is a speed bump for casual
 * abuse, not an identity. Anything stronger needs accounts, which this app
 * deliberately doesn't have.
 */
export function callerKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

const MEMORY_KEY = Symbol.for("whisperpay.ratelimit.memory");

type MemoryGlobal = typeof globalThis & {
  [MEMORY_KEY]?: Map<string, number>;
};

async function countInMemory(key: string): Promise<number> {
  const scope = globalThis as MemoryGlobal;
  const counts = (scope[MEMORY_KEY] ??= new Map<string, number>());
  const next = (counts.get(key) ?? 0) + 1;
  counts.set(key, next);

  // The window is in the key, so old keys are dead weight rather than wrong
  // answers. Cleared wholesale once the map is implausibly large.
  if (counts.size > 10_000) counts.clear();
  return next;
}

async function countInStore(
  key: string,
  windowSeconds: number
): Promise<number> {
  const credentials = restCredentials();
  if (!credentials) return countInMemory(key);

  const root = credentials.url.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${credentials.token}` };
  const encoded = encodeURIComponent(KEY_PREFIX + key);

  const response = await fetch(`${root}/incr/${encoded}`, {
    headers,
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Rate limit store failed (${response.status}).`);
  }
  const body = (await response.json()) as { result?: number };
  const count = typeof body.result === "number" ? body.result : 1;

  // Only the first caller in a window sets the expiry. Re-setting it on every
  // hit would slide the window forward and make the limit unreachable.
  if (count === 1) {
    await fetch(`${root}/expire/${encoded}/${windowSeconds}`, {
      headers,
      cache: "no-store",
    });
  }

  return count;
}

/**
 * Count this call against `bucket`, and say whether it may proceed.
 *
 * An unreachable store is answered with `ok: true`. A rate limiter that fails
 * closed turns one broken dependency into a broken feature; this one guards a
 * cost, and the cost of being briefly unguarded is smaller than the cost of
 * refusing everyone.
 */
export async function rateLimit(
  bucket: string,
  caller: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const key = `${bucket}:${caller}:${windowStart}`;
  const resetIn = windowStart + windowSeconds - now;

  let count: number;
  try {
    count = await countInStore(key, windowSeconds);
  } catch {
    return { ok: true, remaining: limit, resetIn };
  }

  return {
    ok: count <= limit,
    remaining: Math.max(0, limit - count),
    resetIn,
  };
}
