/**
 * Resolve the `@/…` path alias for Node's built-in test runner.
 *
 * The app's imports go through tsconfig's `paths`, which Node knows nothing
 * about. Rather than rewrite source imports to relative paths just to make
 * tests runnable, this maps `@/x` to `src/x.ts` (or `src/x/index.ts`) the same
 * way the bundler does. Keeps the test runner dependency-free.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);

export function resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith("@/")) return nextResolve(specifier, context);

  const base = specifier.slice(2);
  for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    const url = new URL(candidate, SRC);
    if (existsSync(fileURLToPath(url))) {
      return nextResolve(url.href, context);
    }
  }
  return nextResolve(specifier, context);
}
