import type { NextRequest } from "next/server";

import type { RequestStatus, StatusRecord } from "@/lib/request/types";
import { getStatusStore } from "@/lib/store";
import { awaitPoolTransaction, isValidTxHash } from "@/lib/strk20/verify";

/**
 * Request status.
 *
 * Status is the one thing a self-contained link can't carry, so it lives here —
 * and only here. Paying never depends on this endpoint: if no store is
 * configured, status simply stays unknown and the payment flow is unaffected.
 *
 * Everything here is readable by anyone holding the id, so a record is kept
 * deliberately empty of anything worth reading: a lifecycle state and two
 * timestamps. The reported transaction hash is verified and discarded rather
 * than stored — `StatusRecord` explains why. `/s/<id>` renders this same data
 * as a page that can be shared without sharing the invoice.
 *
 * GET  → the current record, or `pending` when nothing has been recorded.
 * POST → `{ txHash }` to report a payment. The hash is verified against the
 *        chain before anything is written, and a verified hash settles the
 *        request on its own.
 *      → `{ action: "confirm" }` to mark a request received by hand, for money
 *        that arrived without anyone reporting it.
 *
 * A recurring request tracks each installment separately, under `<id>.<index>`
 * (`installmentStatusId`), since one month being paid says nothing about the
 * next. The id itself is base64url and never contains a dot, so the suffix is
 * unambiguous.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}(?:\.\d{1,3})?$/;

/**
 * Room for `awaitPoolTransaction` to outlast the gap between a wallet
 * returning a hash and the chain having a receipt. 60s is the Vercel Hobby
 * ceiling; the verifier's own budget sits well below it so a reply still
 * gets out even if the last RPC call hangs.
 *
 * Worth naming the cost: this endpoint takes no authentication — it can't,
 * since the payer is whoever holds the link — so anyone can make it hold an
 * invocation for the budget by posting a hash that will never exist. An
 * already-settled request returns without polling, which covers repeats;
 * fresh ids are not covered, and rate limiting is the real answer.
 */
export const maxDuration = 60;

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

  // Marking a request received by hand — for a payment that arrived without a
  // report, since a reported one settles itself.
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

  // A request that's already settled needs no second opinion, and saying so
  // costs one store read instead of up to half a minute of polling. The
  // payer's own retries land here whenever an earlier attempt got through.
  try {
    const settled = await store.get(id);
    if (settled?.status === "confirmed") {
      return Response.json({ durable: store.durable, record: settled });
    }
  } catch {
    /* an unreadable store is not a reason to refuse the report */
  }

  // Waits for a transaction that's merely young — see `awaitPoolTransaction`.
  // The report arrives with `keepalive`, so this finishes even when the payer
  // has already closed the tab, which is the case that used to strand a
  // request on "Awaiting payment" with nobody left to fix it.
  const verification = await awaitPoolTransaction(input.txHash);
  if (!verification.ok) {
    return Response.json(
      { error: verification.reason ?? "Transaction could not be verified.", verification },
      { status: 422 }
    );
  }

  // A verified hash settles the request, and is then dropped — see
  // `StatusRecord`. What's kept is that *a* verified pool transaction was
  // reported, and when. See `RequestStatus` for what that does and doesn't
  // establish.
  const record: StatusRecord = {
    id,
    status: "confirmed" satisfies RequestStatus,
    submittedAt: now,
    confirmedAt: now,
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
  return Response.json({
    durable: store.durable,
    record,
    verification: extra,
  });
}
