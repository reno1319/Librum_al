import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { assertSupabaseEnvSafeForExecution } from "@/lib/supabase/env-guard";

export async function createClient() {
  // AUTH-STAGE-1A: see env-guard.ts -- throws before any client is
  // constructed if this execution's Supabase project ref doesn't match
  // what's allowed for this environment (production ref only in Vercel
  // Production, never anywhere else).
  assertSupabaseEnvSafeForExecution();

  const cookieStore = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            );
          } catch {
            // Ignored: called from a Server Component, where cookies can't
            // be written. The middleware below refreshes the session instead.
          }
        },
      },
    },
  );
}
