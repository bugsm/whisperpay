/**
 * The pure half of the reserve-then-count command sent to Upstash's
 * `/pipeline` endpoint.
 *
 * Kept apart from `./ratelimit`, which is `server-only`, for the same reason
 * `./caller` is: this is the shape worth pinning down in a test, and a shape
 * that can't be tested is one a refactor can silently break — including the
 * exact "digest with no deadline" bug this pair of commands exists to
 * prevent. See `./ratelimit` for how these are sent against a real store and
 * why the two commands travel together, reservation first.
 */

/** One reply inside a `/pipeline` response — Upstash's shape, not Redis's. */
export interface PipelineReply {
  result?: unknown;
  error?: string;
}

/**
 * The two commands that reserve `key`'s TTL if it has none, then count one
 * hit against it — reservation first, so `INCR` never meets a key with no
 * deadline. `ttlSeconds` is trusted as already floored; see `MIN_TTL_SECONDS`
 * in `./ratelimit`, which is the thing that knows what it's floored against.
 */
export function reserveAndCountCommands(
  key: string,
  ttlSeconds: number
): string[][] {
  return [
    ["SET", key, "0", "EX", String(ttlSeconds), "NX"],
    ["INCR", key],
  ];
}

/** What reading a `/pipeline` reply to `reserveAndCountCommands` produced. */
export type ReserveAndCountReply =
  | { ok: true; count: number }
  | { ok: false; reason: string };

/**
 * The count out of a `/pipeline` reply, or why it can't be trusted.
 *
 * Every one of these is a store that answered — a transport failure or an
 * abort never reaches this function at all — so every `ok: false` here is
 * something worth a line in the deployment log, which is what `./ratelimit`
 * does with `reason`. `rateLimit` fails open regardless; this only decides
 * what's said about why.
 */
export function readReserveAndCountReply(replies: unknown): ReserveAndCountReply {
  if (!Array.isArray(replies) || replies.length !== 2) {
    return {
      ok: false,
      reason: "the /pipeline reply wasn't the two answers this expects",
    };
  }

  const [reserve, increment] = replies as [PipelineReply, PipelineReply];
  if (reserve?.error) return { ok: false, reason: reserve.error };
  if (increment?.error) return { ok: false, reason: increment.error };
  if (typeof increment?.result !== "number") {
    return { ok: false, reason: "INCR didn't answer a number" };
  }

  return { ok: true, count: increment.result };
}
