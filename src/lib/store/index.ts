import "server-only";

import type { StatusRecord } from "@/lib/request/types";
import { parseRecord } from "./record";

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
    async set(record) {
      records.set(record.id, record);
    },
  };
}

/**
 * The REST credentials, under either name a host might supply them.
 *
 * Nothing here was ever tied to Vercel KV the product — the store speaks
 * Upstash's REST API over plain `fetch`, and Vercel KV happened to be Upstash
 * underneath, so one implementation served both and only the variable names
 * differed. Vercel KV has since been retired in favour of Marketplace
 * integrations that inject `UPSTASH_REDIS_REST_*` instead.
 *
 * So both spellings are read. A database provisioned either way works without
 * anyone copying credentials into a second pair of variables, and neither name
 * is the "real" one.
 *
 * `REDIS_URL` (`redis://…`) is deliberately not read even when a host provides
 * it: that's the TCP protocol, which needs a Redis client library and a socket,
 * and this store is REST-over-fetch precisely to avoid both.
 */
function restCredentials(): { url: string; token: string } | undefined {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  return url && token ? { url, token } : undefined;
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
