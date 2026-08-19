/**
 * Resolve the app's import styles for Node's built-in test runner.
 *
 * Two things the bundler does and Node doesn't. First, tsconfig's `paths`, so
 * `@/x` becomes `src/x.ts` (or `src/x/index.ts`). Second, extensionless
 * relative imports — `./codec` rather than `./codec.ts` — which the app writes
 * throughout and Node's ESM resolver rejects outright.
 *
 * Handling both here rather than rewriting source imports keeps the test runner
 * dependency-free, and keeps a module's testability from depending on which
 * import style its neighbours happened to use.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = new URL("../src/", import.meta.url);

const EXTENSIONS = [".ts", ".tsx", "/index.ts"];

/** The first candidate that exists on disk, or undefined. */
function firstExisting(base, parent) {
  for (const extension of EXTENSIONS) {
    const url = new URL(`${base}${extension}`, parent);
    if (existsSync(fileURLToPath(url))) return url;
  }
  return undefined;
}

export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const url = firstExisting(specifier.slice(2), SRC);
    return nextResolve(url ? url.href : specifier, context);
  }

  // Relative, and already carrying an extension Node can load — leave it be.
  if (specifier.startsWith(".") && !/\.(ts|tsx|js|mjs|json)$/.test(specifier)) {
    const url = firstExisting(specifier, context.parentURL);
    if (url) return nextResolve(url.href, context);
  }

  return nextResolve(specifier, context);
}
