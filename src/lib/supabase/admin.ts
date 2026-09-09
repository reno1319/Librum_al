import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { assertSupabaseEnvSafeForExecution } from "@/lib/supabase/env-guard";

// Uses the service role key, which bypasses row-level security entirely.
// Only ever import this from trusted server-only code (like the Stripe
// webhook) — never from anything reachable by a browser request.
export function createAdminClient() {
  // AUTH-STAGE-1A: see env-guard.ts -- this is the highest-privilege
  // Supabase client in the app (bypasses RLS), so it gets the same
  // fail-closed project-ref check as every other server-only client.
  assertSupabaseEnvSafeForExecution();

  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
