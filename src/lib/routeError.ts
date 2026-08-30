/**
 * Reading a route's JSON response without trusting its shape.
 *
 * Two client pages parse a fetch response the same defensive way — a route
 * here answers `{ error: string }` on failure, but nothing upstream of it is
 * guaranteed to: a gateway timeout, a proxy's HTML page, a captive portal, or
 * literal JSON `null` can all reach the browser first. Read once here rather
 * than reimplemented per page, so both stay covered by the same guards.
 */

/** What a route here answers with, before any of it is trusted. */
export interface RouteBody {
  [key: string]: unknown;
}

/**
 * The JSON a route sent back, or an empty object.
 *
 * `null` is valid JSON — it parses without throwing, so a plain `.catch(() =>
 * ({}))` misses it, and every property read on the result would then throw.
 * A body that isn't JSON at all (the proxy/gateway cases above) is the far
 * more common failure and is caught the same way.
 */
export async function readRouteBody(response: Response): Promise<RouteBody> {
  try {
    return ((await response.json()) as RouteBody | null) ?? {};
  } catch {
    return {};
  }
}

/**
 * The `error` a route sent, when it is one safe to show as-is.
 *
 * A string from this app's own routes and an object from a gateway: Vercel
 * answers a `maxDuration` timeout with `{"error":{"code":…}}`, which is valid
 * JSON and so survives `readRouteBody` intact. Putting that object where a
 * string is expected is a React exception at render — "Objects are not valid
 * as a React child" — which loses the failure, and whatever state it was
 * about to update, along with it. Anything but a string is dropped here so
 * the caller's own fallback wording stands instead.
 */
export function routeErrorMessage(body: RouteBody): string | undefined {
  return typeof body.error === "string" ? body.error : undefined;
}
