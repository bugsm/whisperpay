import "server-only";

/**
 * The REST credentials, under either name a host might supply them.
 *
 * Nothing here was ever tied to Vercel KV the product — the stores speak
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
 * and these stores are REST-over-fetch precisely to avoid both.
 *
 * Lives apart from `store/index.ts` because there are now two stores behind the
 * same credentials — request status and short-link blobs — and the one that
 * decides whether a deployment is durable at all should not belong to either.
 */
export function restCredentials(): { url: string; token: string } | undefined {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  return url && token ? { url, token } : undefined;
}
