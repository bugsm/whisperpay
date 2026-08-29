import type { NextRequest } from "next/server";

import { IV_LENGTH, MAX_CIPHERTEXT_LENGTH } from "@/lib/bill/crypto";
import { newRequestId } from "@/lib/request/codec";
import {
  getBillStore,
  MAX_TTL_SECONDS,
  MIN_TTL_SECONDS,
} from "@/lib/store/blobs";

/**
 * Park an encrypted bill so its link can be short.
 *
 * The body is `{ ciphertext, iv }`, both base64url, both produced in the
 * browser. This endpoint checks that they are the right shape and the right
 * size and then stores them untouched. It cannot do anything else with them:
 * the key never leaves the fragment of the organiser's URL, so there is no
 * decryption path here to accidentally add later.
 *
 * The two parts are stored joined by `.`, which base64url never contains. That
 * is a delimiter, not an inspection — nothing here reads inside the ciphertext,
 * and there is nothing in it to read.
 *
 * POST { ciphertext, iv, expiresAt? } → { id, path }
 *
 * Two limits worth naming rather than burying:
 *
 * - **A short link can die.** It lives for `min(expiresAt, 30 days)`, and it
 *   goes if the store does. The stateless `/bill/<payload>` link cannot, which
 *   is why that one stays the default and this is opt-in.
 * - **There is no authentication, and no rate limit.** Nobody can read what is
 *   stored, but anyone can fill the store with 8k blobs. The size cap and the
 *   TTL bound the damage; a real limiter is the answer if this is ever more
 *   than a demo. The same gap is named on `/api/status/[id]`.
 */
export async function POST(request: NextRequest) {
  const store = getBillStore();

  // Refused rather than served, deliberately. A short link backed by process
  // memory works once and is dead the moment the next instance answers — and
  // it would look exactly like a working one until then.
  if (!store.durable) {
    return Response.json(
      {
        error:
          "This deployment has no store configured, so a short link would stop working without warning. Share the full bill link instead.",
        durable: false,
      },
      { status: 503 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("Request body must be JSON.");
  }
  if (typeof body !== "object" || body === null) {
    return fail("Request body must be a JSON object.");
  }
  const input = body as Record<string, unknown>;

  if (typeof input.ciphertext !== "string" || !isBase64Url(input.ciphertext)) {
    return fail("`ciphertext` must be a base64url string.");
  }
  if (input.ciphertext.length > MAX_CIPHERTEXT_LENGTH) {
    return fail(
      `\`ciphertext\` must be at most ${MAX_CIPHERTEXT_LENGTH} characters.`
    );
  }
  if (
    typeof input.iv !== "string" ||
    input.iv.length !== IV_LENGTH ||
    !isBase64Url(input.iv)
  ) {
    return fail("`iv` must be a 12-byte base64url string.");
  }

  // The server can't read the expiry off the bill — that's the point — so it is
  // told, and then clamped. A caller can only ever shorten the life of their
  // own link, never extend it past the ceiling.
  const now = Math.floor(Date.now() / 1000);
  let ttlSeconds = MAX_TTL_SECONDS;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const expiresAt = Number(input.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
      return fail("`expiresAt` must be a unix timestamp in seconds.");
    }
    ttlSeconds = Math.min(Math.floor(expiresAt - now), MAX_TTL_SECONDS);
    if (ttlSeconds < MIN_TTL_SECONDS) {
      return fail("That bill has already expired, or expires within the minute.");
    }
  }

  const id = newRequestId();
  try {
    await store.set(id, `${input.iv}.${input.ciphertext}`, ttlSeconds);
  } catch {
    return Response.json(
      { error: "The store couldn't be reached — share the full link instead." },
      { status: 503 }
    );
  }

  return Response.json({ id, path: `/b/${id}`, expiresIn: ttlSeconds }, { status: 201 });
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function fail(message: string) {
  return Response.json({ error: message }, { status: 400 });
}
