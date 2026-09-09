import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {
      // route.ts imports the shared `stripe` client (src/lib/stripe.ts) at
      // module scope, which throws immediately if the SDK gets no API key
      // -- even though these tests never make a real Stripe call. A dummy
      // value only needs to satisfy that constructor; it is never sent
      // anywhere.
      STRIPE_SECRET_KEY: "sk_test_dummy_for_vitest",
      // AUTH-STAGE-1A: a handful of tests (e.g. middleware.test.ts, the
      // Stripe webhook route tests) exercise the real
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
    },
  },
});
