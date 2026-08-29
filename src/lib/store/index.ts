import "server-only";

import type { StatusRecord } from "@/lib/request/types";
import { parseRecord } from "./record";
import { restCredentials } from "./rest";

/**
 * Where request status lives — the one piece of state a link can't carry.
 *
 * Payment itself never depends on this: `/pay/<link>` decodes entirely from the
 * URL, so a payer can always pay even with no store configured. The store only
 * records what happened afterwards (payer submitted a tx, recipient confirmed
 * receipt), which is a nice-to-have on top.
 *
 * Point it at any Upstash-compatible Redis over REST to make it durable — see
 * `restCredentials` for the variables. Without them the app falls back to
 * process memory and says so, rather than pretending status is being persisted.
 */
export interface StatusStore {
  get(id: string): Promise<StatusRecord | null>;
  /**
   * Several ids at once, answered positionally: result `i` belongs to `ids[i]`,
   * and a missing record is `null` rather than a gap.
   *
   * Exists for the split-bill page, which needs the state of every line to say
   * "5 of 8 paid" and would otherwise open one round trip per person on every
   * render.
   */
  getMany(ids: string[]): Promise<(StatusRecord | null)[]>;
  set(record: StatusRecord, ttlSeconds?: number): Promise<void>;
  /** False for the in-memory fallback — surfaced in the UI so nobody is misled. */
  readonly durable: boolean;
}

const KEY_PREFIX = "whisperpay:status:";

/**
 * A status record outlives nothing. Seven days matches the window the browser
 * keeps its own history for, so a request and its status disappear together
 * rather than leaving a status page for an invoice nobody can produce.
 */
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 7;

/**
 * How many keys one `MGET` may carry.
 *
 * The keys go in the path, so an unbounded batch is an unbounded URL. Twenty is
 * a whole bill (`MAX_SHARES`) in a single round trip, and anything larger is
 * chunked rather than refused — a cap that turns into an error is a cap the
 * caller has to know about.
 */
const MAX_BATCH = 20;

/**
 * Upstash-compatible REST store. Chosen over a client library so there's no
 * extra dependency and no connection pooling to worry about on serverless.
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

    async getMany(ids) {
      const records: (StatusRecord | null)[] = [];

      for (let start = 0; start < ids.length; start += MAX_BATCH) {
        const batch = ids.slice(start, start + MAX_BATCH);
        const path = batch
          .map((id) => encodeURIComponent(KEY_PREFIX + id))
          .join("/");
        const response = await fetch(`${root}/mget/${path}`, {
          headers,
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`Status store read failed (${response.status}).`);
        }
        const body = (await response.json()) as {
          result?: (string | null)[] | null;
        };
        const values = body.result ?? [];
        // Positional, so a short answer can't shift every later record onto the
        // wrong line — the missing tail reads as "nothing recorded".
        for (let offset = 0; offset < batch.length; offset += 1) {
          const value = values[offset];
          records.push(value ? parseRecord(value) : null);
        }
      }

      return records;
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
 *
 * The map hangs off `globalThis` rather than this module's scope, because
 * "this module" isn't one thing: Next compiles route handlers and server
 * components into separate bundles, so `/api/status/[id]` and `/s/[id]` each
 * get their own instance of this file. A module-scoped map means the page can
 * never see what the route wrote, and status sits at `pending` forever with
 * everything else working — which is exactly how it fails. One map per process
 * also survives dev-server hot reloads.
 */
const MEMORY_KEY = Symbol.for("whisperpay.status.memory");

type MemoryGlobal = typeof globalThis & {
  [MEMORY_KEY]?: Map<string, StatusRecord>;
};

function createMemoryStore(): StatusStore {
  const scope = globalThis as MemoryGlobal;
  const records = (scope[MEMORY_KEY] ??= new Map<string, StatusRecord>());
  return {
    durable: false,
    async get(id) {
      return records.get(id) ?? null;
    },
    // Trivial next to the KV version, and implemented anyway: a store that only
    // half satisfies the interface fails on whichever page happens to use the
    // other half.
    async getMany(ids) {
      return ids.map((id) => records.get(id) ?? null);
    },
    async set(record) {
      records.set(record.id, record);
    },
  };
}

let cached: StatusStore | undefined;

export function getStatusStore(): StatusStore {
  if (cached) return cached;

  const credentials = restCredentials();
  cached = credentials
    ? createKvStore(credentials.url, credentials.token)
    : createMemoryStore();
  return cached;
}
