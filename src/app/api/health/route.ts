import { NextResponse } from "next/server";

// ALL-CUTOVER APP-A: a schema-independent liveness check (per
// ALL_CUTOVER_ARCHITECTURE_V4.md's health-route specification).
// Deliberately constructs no Supabase client, makes no POK or Stripe
// call, and reads no environment/secret value into the response --
// so it stays reachable, and stays meaningful as an "is the app up at
// all" signal, throughout the maintenance window regardless of
// database/provider state. Never gated by ALL_CUTOVER_MAINTENANCE_MODE.
export async function GET() {
  return NextResponse.json({ ok: true }, { status: 200 });
}
