/** Installs the `@/…` resolver before any test module loads. See `npm test`. */
import { register } from "node:module";

register("./alias-hooks.mjs", import.meta.url);
