import type { NextRequest } from "next/server";

import {
  isAllowedMediaType,
  NotaConfigError,
  NotaOutputError,
  NotaScanError,
  NotaUpstreamError,
} from "@/lib/ai/nota";
import { scanNota } from "@/lib/ai/scan";
import { callerKey, rateLimit } from "@/lib/store/ratelimit";

/**
 * Read a receipt photo into a draft bill.
 *
 * POST { image: <base64>, mediaType: "image/jpeg" } → { nota }
 *
 * The image is passed through to the model and never stored — see the module
 * comment on `@/lib/ai/scan`, which is where it actually goes. Nothing about
 * the image or its contents is logged here either, including in the error
 * paths: a failed scan says what went wrong, not what it was looking at.
 *
 * Three guards, all of them load-bearing rather than defensive habit. This is
 * the only endpoint in the app that costs money to answer and the only one that
 * accepts a large body:
 *
 * - **Size.** Capped well under the 4.5 MB a serverless request body may carry.
 *   The browser downscales before it posts, so a phone photo arrives at a few
 *   hundred kilobytes; this is the backstop for everything else.
 * - **Type.** An allow-list of image formats, checked against the same list the
 *   scanner uses. A PDF or an SVG is refused rather than forwarded.
 * - **Rate.** A handful of scans per caller per window. The limiter is a speed
 *   bump, not an identity check — `callerKey` explains why that is the ceiling
 *   for an app with no accounts.
 */

/** Room for a model to read a receipt, inside Vercel's ceiling for a function. */
export const maxDuration = 60;

/**
 * The largest base64 image this will accept, in characters.
 *
 * Three megabytes of base64 is roughly 2.2 MB of JPEG — a generous receipt
 * photo, and comfortably under the 4.5 MB total a serverless request body may
 * be. The browser aims far lower than this.
 */
const MAX_IMAGE_CHARS = 3_000_000;

/** Scans per caller per window. Enough for a real bill and a couple of retries. */
const SCAN_LIMIT = 6;
const SCAN_WINDOW_SECONDS = 600;

export async function POST(request: NextRequest) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return Response.json(
      {
        error:
          "Receipt scanning isn't configured on this deployment. Type the lines in instead — everything else works the same.",
      },
      { status: 503 }
    );
  }

  const limit = await rateLimit(
    "nota",
    callerKey(request),
    SCAN_LIMIT,
    SCAN_WINDOW_SECONDS
  );
  if (!limit.ok) {
    return Response.json(
      {
        error: `That's ${SCAN_LIMIT} scans in a short window. Wait about ${Math.ceil(limit.resetIn / 60)} minutes, or type the lines in by hand.`,
      },
      { status: 429, headers: { "Retry-After": String(limit.resetIn) } }
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

  if (typeof input.mediaType !== "string" || !isAllowedMediaType(input.mediaType)) {
    return fail("That file type can't be read. Send a JPEG, PNG or WebP photo.");
  }

  if (typeof input.image !== "string" || input.image === "") {
    return fail("`image` must be a base64 string.");
  }
  if (input.image.length > MAX_IMAGE_CHARS) {
    return fail("That image is too large. Take the photo again at a lower resolution.");
  }
  // Checked before it is forwarded: standard base64, optionally padded.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(input.image)) {
    return fail("`image` isn't valid base64.");
  }

  try {
    const nota = await scanNota({
      data: input.image,
      mediaType: input.mediaType,
    });
    return Response.json({ nota });
  } catch (error) {
    // The typed chain from `@/lib/ai/nota`, each class its own status code.
    // Never a string match on a message.
    if (error instanceof NotaConfigError) {
      return Response.json({ error: error.message }, { status: 503 });
    }
    if (error instanceof NotaUpstreamError) {
      return Response.json({ error: error.message }, { status: 502 });
    }
    if (error instanceof NotaOutputError) {
      return Response.json({ error: error.message }, { status: 422 });
    }
    if (error instanceof NotaScanError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    return Response.json(
      { error: "The scan failed for a reason this server didn't recognise." },
      { status: 500 }
    );
  }
}

function fail(message: string) {
  return Response.json({ error: message }, { status: 400 });
}
