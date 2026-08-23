import type { RequestStatus, StatusRecord } from "@/lib/request/types";

/**
 * Reading a stored status record back, keeping only the fields that belong.
 *
 * Deliberately rebuilt field by field rather than cast, and that distinction is
 * the whole reason this module exists.
 *
 * A cast trusts whatever is in the store to match today's type. That holds
 * right up until the store contains something an older version wrote — and this
 * one did: a previous build kept the payer's transaction hash against the
 * request id, released only against the recipient's signature. That scheme was
 * removed, but removing the code that writes a field does nothing about the
 * records already holding it, and those live out their seven-day TTL. Passed
 * through a cast, they would be served to anyone with the id, by a version
 * whose own documentation says the hash is never stored.
 *
 * So the record is reconstructed from the four fields it is allowed to have.
 * Anything else in the JSON — from an old version, a future one, or a store
 * someone else can write to — is dropped on the way in and cannot reach a
 * response, a re-write, or a page.
 *
 * Kept apart from `store/index.ts` because that module is `server-only` and
 * this logic is worth testing directly. See `record.test.ts`.
 */

const STATUSES: readonly RequestStatus[] = [
  "pending",
  "submitted",
  "confirmed",
  "expired",
];

function isStatus(value: unknown): value is RequestStatus {
  return typeof value === "string" && STATUSES.includes(value as RequestStatus);
}

/** Unix seconds, as the app writes them. */
function timestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

export function parseRecord(raw: string): StatusRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.id !== "string" || !isStatus(candidate.status)) {
    return null;
  }

  const record: StatusRecord = {
    id: candidate.id,
    status: candidate.status,
  };

  const submittedAt = timestamp(candidate.submittedAt);
  if (submittedAt !== undefined) record.submittedAt = submittedAt;

  const confirmedAt = timestamp(candidate.confirmedAt);
  if (confirmedAt !== undefined) record.confirmedAt = confirmedAt;

  return record;
}
