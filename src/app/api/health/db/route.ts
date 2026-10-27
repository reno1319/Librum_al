import { NextResponse } from "next/server";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { assertSupabaseEnvSafeForExecution } from "@/lib/supabase/env-guard";

// ALERTS-1 (Renato 10-27, 2a): the uptime monitor's database check.
// /api/health stays schema-independent on purpose; this route proves
// the database answers too. It makes one tiny read of public data --
// a HEAD request on public_books, the view anonymous visitors already
// read -- with the public anon key, never the service role, so it can
// do nothing a visitor cannot. Every 5 minutes it also keeps the free
// Supabase project from counting as inactive while the Under
// construction lock stops visitors before any database call.
//
// The body is only {"ok":true} or {"ok":false}: no error text, timing
// or configuration value ever reaches the caller. A failure logs its
// error code only. Open while the site lock is on (site-lock.ts).
export const DB_HEALTH_TIMEOUT_MS = 5000;

function result(ok: boolean) {
  return NextResponse.json(
    { ok },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}

export async function GET() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DB_HEALTH_TIMEOUT_MS);
  try {
    assertSupabaseEnvSafeForExecution();
    const supabase = createSupabaseClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { error } = await supabase
      .from("public_books")
      .select("id", { head: true })
      .limit(1)
      .abortSignal(controller.signal);
    if (error) {
      console.error("db health: read failed", { code: error.code ?? null });
      return result(false);
    }
    return result(true);
  } catch (error) {
    console.error("db health: check threw", { error: error instanceof Error ? error.name : "unknown" });
    return result(false);
  } finally {
    clearTimeout(timer);
  }
}
