import "server-only";

import { storedCaller, warnIfUnsalted } from "./caller";
import { readReserveAndCountReply, reserveAndCountCommands } from "./pipeline";
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
 * `SET … EX … NX` plus `INCR`, sent together — one round trip, no Lua.
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
 * How long the store gets to answer before the limit gives up on it.
 *
 * `rateLimit` promises to fail open, and a store that never answers is the
 * case that promise is for — but `fetch` has no timeout of its own, so a
 * stalled Upstash would hold the scan route open until the platform killed it
 * at `maxDuration`. Failing open only helps if it happens quickly.
 *
 * Two seconds is far past a healthy round trip to a regional Redis and far
 * short of anything a reader would sit through, and it is a budget for the
 * whole exchange rather than per request: one signal covers both commands, so
 * a store that stalls on the second costs this once and not twice.
 */
const STORE_TIMEOUT_MS = 2_000;

/**
 * The shortest deadline the reservation below is allowed to carry.
 *
 * The TTL is normally what is left of the window, which at the very end of one
 * is a second — and a reservation that expires before `INCR` reads it is the
 * whole failure the reserve-first ordering exists to prevent: `INCR` would
 * meet a key that had aged out, create it fresh, and leave a digest with no
 * deadline at all. `SET` and `INCR` travel together in one request now (see
 * `reserveAndCount`), so the gap between them is Redis running two commands
 * back to back rather than a second client round trip — but the abort budget
 * still covers the whole exchange, so the floor stays at that budget plus a
 * margin, for the one abort that lands after the reservation but before the
 * reply comes back.
 *
 * What it costs is a key outliving its window by a few seconds. That is a
 * rounding error against ten minutes, it is bounded, and the key is never read
 * again once the window turns — its name carries the window it belongs to.
 */
const MIN_TTL_SECONDS = Math.ceil(STORE_TIMEOUT_MS / 1000) + 2;

/**
 * Who is asking, as far as a proxy will say.
 *
 * `x-forwarded-for` is a list; the client is the first entry. It is trivially
 * spoofable by anyone talking to this app directly, and behind Vercel's proxy
 * the leftmost entry is the real one — so this is a speed bump for casual
 * abuse, not an identity. Anything stronger needs accounts, which this app
 * deliberately doesn't have.
 *
 * This is the address itself. It is read from the request, counted, and
 * dropped — `storedCaller` below is what actually reaches the store.
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

let refusalReported = false;

/**
 * Say, in the deployment log, that the store turned a command down.
 *
 * A store that answers "no" is not the same as one that can't be reached, and
 * it is the worse of the two: an expired token, a proxy that doesn't speak
 * `/pipeline` or `SET … EX … NX`, a database deleted out from under a
 * deployment. None of them recover on their own, and each makes `rateLimit`
 * fail open on every request from then on — silently, because failing open is
 * what it is supposed to do. The endpoint behind this limit is the one that
 * bills a model per call, so without a line here the first sign of it is the
 * invoice.
 *
 * Once per distinct spell of trouble, not once per process: `reserveAndCount`
 * clears the latch on the next success, so a token that gets rotated back to
 * life and then fails again for an unrelated reason — the database itself
 * gone, say — is reported again rather than staying silent because something
 * else already used up the one line this used to print.
 *
 * Whatever the store said about why, and nothing else. The commands carry the
 * caller's digest, and a diagnostic that prints one is worse than none.
 */
function reportRefusal(detail: string): void {
  if (refusalReported) return;

  refusalReported = true;
  console.error(
    `[ratelimit] the store refused a command (${detail}) — the scan limit is failing open until this is fixed. Check the REST credentials, and that the store's /pipeline accepts SET ... EX ... NX and INCR.`
  );
}

/**
 * Reserve this key's TTL if it has none, then count this hit against it — as
 * one request, not two.
 *
 * `SET key 0 EX <ttl> NX` and `INCR key`, sent together through Upstash's
 * `/pipeline` endpoint, which runs a list of commands in order over a single
 * HTTP exchange. Not a transaction — nothing here needs one, since nothing
 * else ever touches this key — just the two commands `countInStore` needs,
 * without paying for a second round trip to get both. See `./pipeline` for
 * the command shape and the reply this expects back.
 *
 * `null` covers every way this doesn't produce a count: transport failure,
 * abort, non-2xx, a body that isn't JSON, or a reply `readReserveAndCountReply`
 * doesn't recognise. `countInStore` throws on `null`, and `rateLimit` turns
 * that into the open door it promises rather than a request left hanging. Every
 * one of those but the first two is the store having answered something this
 * doesn't understand, which `reportRefusal` puts in the log on the way past —
 * a malformed 200 is exactly the kind of "answered but wrong" a silent `null`
 * here would otherwise hide.
 */
async function reserveAndCount(
  root: string,
  headers: Record<string, string>,
  key: string,
  ttlSeconds: number,
  signal: AbortSignal
): Promise<number | null> {
  let response: Response;
  try {
    response = await fetch(`${root}/pipeline`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(reserveAndCountCommands(key, ttlSeconds)),
      signal,
      cache: "no-store",
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    reportRefusal(String(response.status));
    return null;
  }

  let replies: unknown;
  try {
    replies = await response.json();
  } catch {
    reportRefusal("the /pipeline reply wasn't JSON");
    return null;
  }

  const read = readReserveAndCountReply(replies);
  if (!read.ok) {
    reportRefusal(read.reason);
    return null;
  }

  // The one path that reaches here having gone right — see `reportRefusal`
  // for why that's what re-arms it.
  refusalReported = false;
  return read.count;
}

/**
 * `ttlSeconds` is what is left of the window, not its full length — see
 * `rateLimit`, which is the only thing that knows where the boundary is. It is
 * floored at `MIN_TTL_SECONDS` here rather than there, because what the floor
 * is for belongs to this exchange and not to the window.
 */
async function countInStore(
  key: string,
  ttlSeconds: number
): Promise<number> {
  const credentials = restCredentials();
  if (!credentials) return countInMemory(key);

  // Here, not inside the digest: this is the branch where it is written to
  // something that outlives the request, and so the only branch the warning
  // is about.
  warnIfUnsalted();

  const root = credentials.url.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${credentials.token}` };

  // The reservation is what makes the counter safe, and it travels with the
  // count in the same request. Either the key doesn't exist and `NX` creates
  // it holding zero with `EX` seconds to live, or it exists and `SET` does
  // nothing at all — either way `INCR`, right behind it, only ever meets a
  // key that already has a TTL, and preserves it.
  //
  // The order matters more than it looks. `INCR` first and the deadline
  // second is the obvious shape and the wrong one: `INCR` is what creates the
  // key, so anything between the two steps — even just two separate requests
  // — could leave a caller's digest in Redis with no deadline at all. That is
  // not a weaker limit but a permanent record, the one failure here that
  // contradicts `docs/PRIVACY.md` rather than merely degrading a count, and
  // no later request repairs it because the next window uses a different key.
  // Sending both together, reservation first, closes that gap down to Redis
  // running its own command list rather than leaving it open across a second
  // client round trip — see `reserveAndCount`.
  //
  // It is the more portable half too. `SET … NX` with `EX` has been in Redis
  // since 2.6; `EXPIRE … NX` only since 7.0.
  const count = await reserveAndCount(
    root,
    headers,
    KEY_PREFIX + key,
    Math.max(ttlSeconds, MIN_TTL_SECONDS),
    AbortSignal.timeout(STORE_TIMEOUT_MS)
  );
  if (count === null) throw new Error("Rate limit store didn't answer.");

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
  const key = `${bucket}:${storedCaller(caller, windowStart)}:${windowStart}`;
  const resetIn = windowStart + windowSeconds - now;

  let count: number;
  try {
    // `resetIn`, not `windowSeconds`. The key is named for the window it
    // belongs to, so a full window's TTL granted on a late first hit would
    // keep a digest alive well past the window that produced it — up to twice
    // as long as `docs/PRIVACY.md` says it is kept. Expiring at the boundary
    // is what makes that claim true.
    count = await countInStore(key, resetIn);
  } catch {
    return { ok: true, remaining: limit, resetIn };
  }

  return {
    ok: count <= limit,
    remaining: Math.max(0, limit - count),
    resetIn,
  };
}
