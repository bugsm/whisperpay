import type { NextRequest } from "next/server";

import type { RequestStatus, StatusRecord } from "@/lib/request/types";
import { getStatusStore } from "@/lib/store";
import { isValidTxHash, verifyPoolTransaction } from "@/lib/strk20/verify";

/**
 * Request status.
 *
 * Status is the one thing a self-contained link can't carry, so it lives here —
 * and only here. Paying never depends on this endpoint: if no store is
 * configured, status simply stays unknown and the payment flow is unaffected.
 *
 * GET  → the current record, or `pending` when nothing has been recorded.
 * POST → `{ txHash }` to report a submitted payment (verified on-chain first),
 *        or `{ action: "confirm" }` for the recipient to confirm receipt.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export async function GET(
  _request: NextRequest,
  context: RouteContext<"/api/status/[id]">
) {
  const { id } = await context.params;
  if (!ID_PATTERN.test(id)) {
    return Response.json({ error: "Invalid request id." }, { status: 400 });
  }

  const store = getStatusStore();
  let record: StatusRecord | null = null;
  try {
    record = await store.get(id);
  } catch {
    return Response.json(
      { error: "Status store unavailable.", durable: store.durable },
      { status: 503 }
    );
  }

  return Response.json({
    durable: store.durable,
    record: record ?? { id, status: "pending" satisfies RequestStatus },
  });
}

export async function POST(
  request: NextRequest,
  context: RouteContext<"/api/status/[id]">
) {
  const { id } = await context.params;
  if (!ID_PATTERN.test(id)) {
    return Response.json({ error: "Invalid request id." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;

  const store = getStatusStore();
  const now = Math.floor(Date.now() / 1000);

  // Recipient confirming they saw the money land in their shielded balance.
  if (input.action === "confirm") {
    let existing: StatusRecord | null = null;
    try {
      existing = await store.get(id);
    } catch {
      /* treat an unreadable store as empty; the write below reports failure */
    }

    const record: StatusRecord = {
      ...(existing ?? { id, status: "pending" }),
      id,
      status: "confirmed",
      confirmedAt: now,
    };
    return persist(store, record);
  }

  // Payer reporting the transaction they just submitted.
  if (typeof input.txHash !== "string" || !isValidTxHash(input.txHash)) {
    return Response.json(
      { error: "`txHash` must be a valid transaction hash." },
      { status: 400 }
    );
  }

  const verification = await verifyPoolTransaction(input.txHash);
  if (!verification.ok) {
    return Response.json(
      { error: verification.reason ?? "Transaction could not be verified.", verification },
      { status: 422 }
    );
  }

  const record: StatusRecord = {
    id,
    status: "submitted" satisfies RequestStatus,
    txHash: input.txHash,
    submittedAt: now,
  };
  return persist(store, record, verification);
}

async function persist(
  store: ReturnType<typeof getStatusStore>,
  record: StatusRecord,
  extra?: unknown
) {
  try {
    await store.set(record);
  } catch {
    return Response.json(
      {
        error: "Status store unavailable — the payment itself is unaffected.",
        durable: store.durable,
        record,
      },
      { status: 503 }
    );
  }
  return Response.json({ durable: store.durable, record, verification: extra });
}
