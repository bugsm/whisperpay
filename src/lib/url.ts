/**
 * Build an absolute URL for a path, respecting proxy headers.
 *
 * `request.url` is unreliable behind Vercel's proxy (it reports the internal
 * origin), so forwarded headers win when present. `NEXT_PUBLIC_APP_URL`
 * overrides everything, for deployments that sit behind a custom domain.
 */
export function absoluteUrl(request: Request, path: string): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) {
    return new URL(path, configured).toString();
  }

  const headers = request.headers;
  const host = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!host) {
    return new URL(path, request.url).toString();
  }

  const proto =
    headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");

  return new URL(path, `${proto}://${host}`).toString();
}
