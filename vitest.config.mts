import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    env: {
      // AUTH-STAGE-1A: a handful of tests (e.g. middleware.test.ts)
      // exercise the real
      // src/lib/supabase/{server,admin,middleware}.ts client constructors
      // rather than mocking them, only mocking the underlying
      // @supabase/ssr or @supabase/supabase-js SDK calls further down.
      // Those constructors now call assertSupabaseEnvSafeForExecution()
      // (see env-guard.ts) before doing anything else, so they need SOME
      // syntactically valid, non-production Supabase URL to pass that
      // check. This is a fixed, obviously-fake 20-char ref -- not the
      // real production or staging ref -- deliberately not the real
      // production ref, so it stays rejected even if a future test sets
      // VERCEL_ENV=production by mistake. VERCEL_ENV itself is
      // deliberately left unset here, matching every non-Vercel-Production
      // execution this guard treats as non-production.
      NEXT_PUBLIC_SUPABASE_URL: "https://dummyreffortestingx0.supabase.co",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(dirname, "src"),
      // ALL-CUTOVER APP-A: Vitest runs under Node with no "react-server"
      // condition, so the real server-only package (a direct dependency
      // of src/lib/maintenance-mode.ts/maintenance-response.ts) resolves
      // to its default export, which unconditionally throws by design.
      // Test-only: aliased to an empty stub so those modules' own
      // production `import "server-only"` can load under Vitest. Never
      // read by next.config.ts or any Next.js build/dev command -- the
      // production import target and its enforced boundary are
      // unaffected outside a Vitest run. See vitest.server-only-stub.ts.
      "server-only": path.resolve(dirname, "vitest.server-only-stub.ts"),
    },
  },
});
