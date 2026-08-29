import type { NextRequest } from "next/server";

import { getBillStore } from "@/lib/store/blobs";

/**
 * Hand back an encrypted bill.
 *
 * The reply is the two base64url strings that were posted, and nothing else.
 * Whoever asks gets the ciphertext whether or not they hold the key — the key
 * is what makes it a bill rather than noise, and it never came here.
 *
 * A missing id is an ordinary answer, not an error to be explained away: a
 * short link expires, and the page above turns this 404 into a sentence saying
 * so.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/bills/[id]">
) {
  const { id } = await context.params;
  if (!ID_PATTERN.test(id)) {
    return Response.json({ error: "Invalid bill id." }, { status: 400 });
  }

  const store = getBillStore();
  let stored: string | null;
  try {
    stored = await store.get(id);
  } catch {
    return Response.json(
      { error: "The bill store couldn't be reached." },
      { status: 503 }
    );
  }

  if (stored === null) {
    return Response.json(
      { error: "This short link has expired, or never existed." },
      { status: 404 }
    );
  }

  // Split on the delimiter the write side joined with. base64url contains no
  // `.`, so the first one is the only one.
  const separator = stored.indexOf(".");
  if (separator === -1) {
    return Response.json(
      { error: "This bill's stored data is unreadable." },
      { status: 500 }
    );
  }

  return Response.json({
    iv: stored.slice(0, separator),
    ciphertext: stored.slice(separator + 1),
  });
}
