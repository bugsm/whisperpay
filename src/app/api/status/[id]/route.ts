import type { NextRequest } from "next/server";
import { verifyMessageInStarknet, type Signature } from "starknet";

import { recipientCommitment, revealTypedData } from "@/lib/request/proof";
import type { RequestStatus, StatusRecord } from "@/lib/request/types";
import { getStatusStore } from "@/lib/store";
import { isValidAddress } from "@/lib/strk20/constants";
import { mainnetProvider } from "@/lib/strk20/provider";
import { isValidTxHash, verifyPoolTransaction } from "@/lib/strk20/verify";

/**
 * Request status.
 *
 * Status is the one thing a self-contained link can't carry, so it lives here —
 * and only here. Paying never depends on this endpoint: if no store is
 * configured, status simply stays unknown and the payment flow is unaffected.
 *
 * What `GET` returns is readable by anyone holding the id, so it is kept
 * deliberately empty of anything worth reading: a lifecycle state and two
 * timestamps. The transaction hash is stored but never served here — see
 * `StatusRecord` and `proof.ts`. `/s/<id>` renders this same data as a page
 * that can be shared without sharing the invoice.
 *
 * GET  → the current record, or `pending` when nothing has been recorded.
 * POST → `{ txHash, recipientCommitment? }` to report a payment. The hash is
 *        verified against the chain before anything is written, and a verified
 *        hash settles the request on its own.
 *      → `{ action: "confirm" }` to mark a request received by hand, for money
 *        that arrived without anyone reporting it.
 *      → `{ action: "reveal", address, signature }` for the recipient to claim
 *        the stored transaction hash, proven by signature.
 *
 * A recurring request tracks each installment separately, under `<id>.<index>`
 * (`installmentStatusId`), since one month being paid says nothing about the
 * next. The id itself is base64url and never contains a dot, so the suffix is
 * unambiguous.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,32}(?:\.\d{1,3})?$/;

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
    record: record
      ? redact(record)
      : { id, status: "pending" satisfies RequestStatus },
    hasProof: Boolean(record?.txHash && record.recipientCommitment),
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

  // Recipient claiming the proof. Verified against the account contract
  // on-chain, so any account implementation works, not just Stark-curve keys.
  if (input.action === "reveal") {
    return reveal(id, input);
  }

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

  const verification = await verifyPoolTransaction(input.txHash);
  if (!verification.ok) {
    return Response.json(
      { error: verification.reason ?? "Transaction could not be verified.", verification },
      { status: 422 }
    );
  }

  // A verified hash settles the request. See `RequestStatus` for what that does
  // and doesn't establish — the hash is kept precisely so the recipient can
  // judge it themselves rather than trust this badge.
  const record: StatusRecord = {
    id,
    status: "confirmed" satisfies RequestStatus,
    submittedAt: now,
    confirmedAt: now,
    txHash: input.txHash.trim(),
    recipientCommitment: isCommitment(input.recipientCommitment)
      ? input.recipientCommitment
      : undefined,
  };
  return persist(store, record, verification);
}

/** Lowercase SHA-256 hex, as `recipientCommitment` produces. */
function isCommitment(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Release the stored transaction hash to whoever can sign for the address the
 * request was addressed to.
 *
 * Two things have to hold, and the order matters: the signature must be valid
 * for the claimed address, and that address must be the one committed to when
 * the payment was reported. Checking the commitment first would turn this into
 * an oracle for testing address guesses without ever signing anything.
 */
async function reveal(
  id: string,
  input: Record<string, unknown>
): Promise<Response> {
  const address = typeof input.address === "string" ? input.address : "";
  const signature = input.signature as Signature | undefined;

  if (!isValidAddress(address) || signature === undefined) {
    return Response.json(
      { error: "A signature and the signing address are both required." },
      { status: 400 }
    );
  }

  const store = getStatusStore();
  let record: StatusRecord | null = null;
  try {
    record = await store.get(id);
  } catch {
    return Response.json({ error: "Status store unavailable." }, { status: 503 });
  }

  if (!record?.txHash) {
    return Response.json(
      { error: "No payment has been reported for this request." },
      { status: 404 }
    );
  }

  let signedByClaimant: boolean;
  try {
    signedByClaimant = await verifyMessageInStarknet(
      mainnetProvider,
      revealTypedData(id),
      signature,
      address
    );
  } catch {
    // An undeployed account has no `is_valid_signature` to call. Nothing to
    // distinguish that from a bad signature, and nothing that should be said
    // differently about it.
    signedByClaimant = false;
  }

  if (!signedByClaimant) {
    return Response.json({ error: "That signature isn't valid." }, { status: 401 });
  }

  const expected = await recipientCommitment(id, address);
  if (record.recipientCommitment !== expected) {
    return Response.json(
      {
        error:
          "This payment wasn't addressed to that account, so its proof isn't yours to read.",
      },
      { status: 403 }
    );
  }

  return Response.json({ txHash: record.txHash });
}

/**
 * Everything a caller is entitled to see, and nothing else.
 *
 * Applied to every response rather than filtered at each call site, because the
 * one that gets forgotten is the one that matters: `confirm` carries the
 * existing record forward, so echoing it back unredacted would hand the stored
 * transaction hash to anyone who knows the id — exactly what the signed reveal
 * exists to prevent.
 */
function redact(record: StatusRecord): StatusRecord {
  return {
    id: record.id,
    status: record.status,
    submittedAt: record.submittedAt,
    confirmedAt: record.confirmedAt,
  };
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
        record: redact(record),
      },
      { status: 503 }
    );
  }
  return Response.json({
    durable: store.durable,
    record: redact(record),
    verification: extra,
  });
}
