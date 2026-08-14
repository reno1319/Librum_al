import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Uses the service role key, which bypasses row-level security entirely.
// Only ever import this from trusted server-only code (like the Stripe
// webhook) — never from anything reachable by a browser request.
export function createAdminClient() {
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}
