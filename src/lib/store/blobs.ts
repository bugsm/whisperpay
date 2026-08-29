import "server-only";

import { restCredentials } from "./rest";

/**
 * Where an encrypted bill is parked so its link can be short.
 *
 * This store holds bytes it cannot read, and that is the entire design. The
 * browser encrypts the bill, posts the ciphertext, and keeps the key in the URL
 * fragment; what arrives here is opaque, and nothing in this module or the
 * route above it ever tries to parse it. There is no shape to validate because
 * there is no shape — a bill and a corrupt upload look identical from here, and
 * both are handed back exactly as they came in.
 *
 * Kept apart from the status store on purpose. That one is a typed record
 * rebuilt field by field on the way out (`parseRecord`), precisely so an old
 * version's fields can't leak through. Sharing an implementation would put the
 * two under one set of expectations when their whole relationship to their own
 * contents is opposite.
 */
export interface BlobStore {
  get(id: string): Promise<string | null>;
  set(id: string, blob: string, ttlSeconds: number): Promise<void>;
  /**
   * False for the in-memory fallback.
   *
   * This one gates a feature rather than a warning. A short link whose store
   * forgets it on the next instance is a dead link, so the option is not
   * offered and the route refuses to mint one — see `POST /api/bills`.
   */
  readonly durable: boolean;
}

const KEY_PREFIX = "whisperpay:bill:";

/**
 * The longest a short link may live.
 *
 * Thirty days is well past the life of any bill anyone splits, and short enough
 * that the store never becomes an archive. A bill with an earlier expiry gets
 * the earlier one — `min(expiresAt, 30 days)`.
 */
export const MAX_TTL_SECONDS = 60 * 60 * 24 * 30;

/** Below a minute there is no point storing anything at all. */
export const MIN_TTL_SECONDS = 60;

function createKvBlobStore(baseUrl: string, token: string): BlobStore {
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
        throw new Error(`Bill store read failed (${response.status}).`);
      }
      const body = (await response.json()) as { result?: string | null };
      return body.result ?? null;
    },

    async set(id, blob, ttlSeconds) {
      const response = await fetch(
        `${root}/set/${encodeURIComponent(KEY_PREFIX + id)}?EX=${ttlSeconds}`,
        {
          method: "POST",
          headers: { ...headers, "Content-Type": "text/plain" },
          body: blob,
          cache: "no-store",
        }
      );
      if (!response.ok) {
        throw new Error(`Bill store write failed (${response.status}).`);
      }
    },
  };
}

/**
 * Process-local fallback, on `globalThis` for the same reason the status store's
 * map is: the route that writes and the page that reads are compiled into
 * separate bundles, so a module-scoped map would mean the page never sees the
 * write.
 *
 * It exists so a local demo works, not so a deployment can do without a store.
 * `durable` stays false and the feature stays switched off wherever it matters.
 */
const MEMORY_KEY = Symbol.for("whisperpay.bills.memory");

type MemoryGlobal = typeof globalThis & {
  [MEMORY_KEY]?: Map<string, { blob: string; expiresAt: number }>;
};

function createMemoryBlobStore(): BlobStore {
  const scope = globalThis as MemoryGlobal;
  const blobs = (scope[MEMORY_KEY] ??= new Map());

  return {
    durable: false,
    async get(id) {
      const entry = blobs.get(id);
      if (!entry) return null;
      // Expiry is honoured even here, so the fallback can't quietly outlive
      // what the real store would have dropped.
      if (entry.expiresAt <= Date.now() / 1000) {
        blobs.delete(id);
        return null;
      }
      return entry.blob;
    },
    async set(id, blob, ttlSeconds) {
      blobs.set(id, {
        blob,
        expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
      });
    },
  };
}

let cached: BlobStore | undefined;

export function getBillStore(): BlobStore {
  if (cached) return cached;

  const credentials = restCredentials();
  cached = credentials
    ? createKvBlobStore(credentials.url, credentials.token)
    : createMemoryBlobStore();
  return cached;
}
