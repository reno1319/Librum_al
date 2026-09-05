import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // BLOG-1C.1: standard typescript-eslint convention (the pattern its
  // own docs recommend) for a function parameter that must exist for
  // arity/type correctness -- e.g. a test double whose call signature
  // has to match the real function it stands in for, so
  // `.mock.calls[n][k]` indexes correctly -- but is never read inside
  // the function body. Scoped to `args` only (never `varsIgnorePattern`
  // or similar), so a genuinely unused top-level variable is still
  // flagged everywhere; this never distorts a signature to silence
  // lint, it just recognizes the leading-underscore name already used
  // for exactly this purpose across the blog admin test suite.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
