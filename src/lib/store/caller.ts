/**
 * What the rate-limit store is allowed to hold about a caller.
 *
 * Kept apart from `./ratelimit`, which is `server-only` and holds the counting.
 * This is the part worth testing directly — it carries a privacy claim, and a
 * claim that can't be tested is a claim that quietly stops being true. Same
 * split, and the same reason, as `store/record.ts` against `store/index.ts`.
 */

import { createHash } from "node:crypto";

let saltReported = false;

/**
 * The secret that makes the digest below irreversible rather than merely
 * opaque.
 *
 * IPv4 is 2^32 addresses. Anyone holding the stored digests and this file can
 * hash the whole space in seconds and recover every address, so an unsalted
 * hash is obfuscation and not privacy. The salt is the entire defence — which
 * is why its absence is reported rather than passing quietly, by
 * `warnIfUnsalted` below.
 */
function salt(): string {
  return process.env.RATELIMIT_SALT?.trim() ?? "";
}

/**
 * Say once, in the deployment log, that the digest is unsalted.
 *
 * Apart from `salt()` and called by the counter rather than reached from
 * inside it, because the warning is only true where a digest is actually
 * written down. With no Redis the limiter counts in a per-process map — which
 * is every local `next dev` — and nothing is stored, nothing outlives the
 * process, and there is nothing for anyone to reverse. A security warning
 * about data that isn't kept teaches the reader to stop reading the log.
 *
 * Once per process: this sits on the scan path, and a line repeated every
 * request buries itself.
 */
export function warnIfUnsalted(): void {
  if (saltReported || salt() !== "") return;

  saltReported = true;
  console.error(
    "[ratelimit] RATELIMIT_SALT isn't set — stored counters can be reversed to the address they came from by enumerating IPv4. Set it to any long random string."
  );
}

/**
 * The stored form of one caller, inside one window.
 *
 * The counter has to tell two callers apart within a window. It never has to
 * know who either of them is, and nothing ever reads the value back — so a
 * digest does the whole job and the address stays out of Redis.
 *
 * The window start is folded in, so the same address digests to something
 * different in the next window. Hashing the address alone would leave one
 * stable identifier per person sitting in the store, and two dumps taken a day
 * apart would link that person's scans across days — the same correlation the
 * rest of this app spends its effort breaking, rebuilt in the one place that
 * had no reason to.
 */
export function storedCaller(caller: string, windowStart: number): string {
  return createHash("sha256")
    .update(`${salt()}:${windowStart}:${caller}`)
    .digest("hex")
    .slice(0, 32);
}
