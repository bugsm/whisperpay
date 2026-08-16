import "server-only";

import type { StatusRecord } from "@/lib/request/types";

/**
 * Where request status lives — the one piece of state a link can't carry.
 *
 * Payment itself never depends on this: `/pay/<link>` decodes entirely from the
 * URL, so a payer can always pay even with no store configured. The store only
 * records what happened afterwards (payer submitted a tx, recipient confirmed
 * receipt), which is a nice-to-have on top.
 *
 * Configure `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel KV or Upstash
 * Redis) to make it durable. Without them the app falls back to process memory
 * and says so, rather than pretending status is being persisted.
 */
export interface StatusStore {
  get(id: string): Promise<StatusRecord | null>;
  set(record: StatusRecord, ttlSeconds?: number): Promise<void>;
  /** False for the in-memory fallback — surfaced in the UI so nobody is misled. */
  readonly durable: boolean;
}

const KEY_PREFIX = "whisperpay:status:";

/** Records are small and short-lived; 90 days is well past any link's usefulness. */
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 90;

function parseRecord(raw: string): StatusRecord | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as StatusRecord;
    return typeof record.id === "string" && typeof record.status === "string"
      ? record
      : null;
  } catch {
    return null;
  }
}

/**
 * Upstash-compatible REST store (also what Vercel KV speaks). Chosen over a
 * client library so there's no extra dependency and no connection pooling to
 * worry about on serverless.
 */
function createKvStore(baseUrl: string, token: string): StatusStore {
  const root = baseUrl.replace(/\/+$/, "");
  const headers = { Authorization: `Bearer ${token}` };

  return {
    durable: true,

    async get(id) {
      const response = await fetch(
        `${root}/get/${encodeURIComponent(KEY_PREFIX + id)}`,
        { headers, cache: "no-store" }
      );
      if (!response.ok) {
        throw new Error(`Status store read failed (${response.status}).`);
      }
      const body = (await response.json()) as { result?: string | null };
      return body.result ? parseRecord(body.result) : null;
    },

    async set(record, ttlSeconds = DEFAULT_TTL_SECONDS) {
      const response = await fetch(
        `${root}/set/${encodeURIComponent(KEY_PREFIX + record.id)}?EX=${ttlSeconds}`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "text/plain" },
          body: JSON.stringify(record),
          cache: "no-store",
        }
      );
      if (!response.ok) {
        throw new Error(`Status store write failed (${response.status}).`);
      }
    },
  };
}

/**
 * Process-local fallback. Survives navigations during a local demo and nothing
 * else — on serverless each instance gets its own map.
 */
function createMemoryStore(): StatusStore {
  const records = new Map<string, StatusRecord>();
  return {
    durable: false,
    async get(id) {
      return records.get(id) ?? null;
    },
    async set(record) {
      records.set(record.id, record);
    },
  };
}

let cached: StatusStore | undefined;

export function getStatusStore(): StatusStore {
  if (cached) return cached;

  const url = process.env.KV_REST_API_URL;
  const token = process.env.KV_REST_API_TOKEN;

  cached = url && token ? createKvStore(url, token) : createMemoryStore();
  return cached;
}
