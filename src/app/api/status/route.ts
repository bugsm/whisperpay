import type { NextRequest } from "next/server";

import type { RequestStatus, StatusRecord } from "@/lib/request/types";
import { getStatusStore } from "@/lib/store";

/**
 * Several requests' status in one call.
 *
 * `/bill/<payload>` reads its lines on the server and needs none of this. The
 * short-link page does: it decrypts in the browser, so the ids it wants only
 * exist there, and asking for twenty of them one at a time would be twenty
 * round trips on every poll.
 *
 * The batch is what `getMany` already does — one `MGET` — and it discloses
 * nothing a caller couldn't get by asking for each id separately. Status is
 * readable by whoever holds an id, and an id describes nothing on its own.
 *
 * GET /api/status?ids=a,b,c → { durable, records: [...] }, positionally.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}(?:\.\d{1,3})?$/;

/** One full bill. Past this, the caller is asking for someone else's list. */
const MAX_IDS = 20;

export async function GET(request: NextRequest) {
  const raw = request.nextUrl.searchParams.get("ids");
  if (!raw) {
    return Response.json({ error: "`ids` is required." }, { status: 400 });
  }

  const ids = raw.split(",").filter((id) => id !== "");
  if (ids.length === 0) {
    return Response.json({ error: "`ids` is required." }, { status: 400 });
  }
  if (ids.length > MAX_IDS) {
    return Response.json(
      { error: `At most ${MAX_IDS} ids per request.` },
      { status: 400 }
    );
  }
  if (ids.some((id) => !ID_PATTERN.test(id))) {
    return Response.json({ error: "One of those ids isn't valid." }, { status: 400 });
  }

  const store = getStatusStore();
  let records: (StatusRecord | null)[];
  try {
    records = await store.getMany(ids);
  } catch {
    return Response.json(
      { error: "Status store unavailable.", durable: store.durable },
      { status: 503 }
    );
  }

  return Response.json({
    durable: store.durable,
    records: records.map(
      (record, index) =>
        record ?? { id: ids[index], status: "pending" satisfies RequestStatus }
    ),
  });
}
