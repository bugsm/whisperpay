import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // Much of this UI is explanatory prose about what is and isn't private,
      // and it reads better with real apostrophes than with &apos; scattered
      // through it. JSX text is escaped by React either way, so this is a
      // typographic preference rather than a correctness rule.
      "react/no-unescaped-entities": "off",
    },
  },
]);

export default eslintConfig;
