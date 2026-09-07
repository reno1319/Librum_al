import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  deriveTiranaTargetMonth,
  isSchedulerEnabled,
  parseStrictTargetMonth,
  runDryRunPass,
  runReservationPass,
} from "@/lib/payout-scheduler";

// LEDGER-1E-D-D: the internal application scheduler route for the
// payout-scheduler DB foundation (migration 053, already live in
// production). Mirrors the established machine-to-machine conventions
// of src/app/api/internal/reconcile-transfer-reversals/route.ts
// (CRON_SECRET bearer auth, GET+POST, createAdminClient(), fail
// closed) -- there is deliberately only ONE internal-job authentication
// pattern in this repo, not a second one invented here.
//
// CRON REGISTRATION (Section 3/35, updated by LEDGER-1E-D-G): this
// route's monthly cron entry now IS registered in vercel.json
// ("0 6 5 * *" -- see src/lib/payout-cycle.ts for the approved
// business policy this schedule encodes, and
// src/lib/vercel-cron-config.test.ts for the structural regression
// guard). Registering the cron only means Vercel will issue the GET
// request below on schedule -- it does NOT arm reservation execution
// on its own; that remains a separate switch (immediately below).
//
// PAYOUT_SCHEDULER_ENABLED IS STILL NOT SET ANYWHERE (Section 8/36):
// the application logic below reads it, but no Vercel env var, local
// secret, or committed config sets a value. A missing value means
// disabled -- see isSchedulerEnabled()'s own fail-closed rule. So even
// though the cron now fires monthly, EVERY reserve-mode request it
// triggers (the GET handler below) remains a safe, deterministic,
// zero-RPC no-op until PAYOUT_SCHEDULER_ENABLED is explicitly set to
// "true" in a separate, future task.
//
// This route calls ONLY the four migration-053 scheduler RPCs
// (dry_run_scheduled_payouts, start_scheduled_payout_run,
// reserve_author_payout, complete_scheduled_payout_run) -- see
// src/lib/payout-scheduler.ts, which owns all orchestration logic and
// is unit-tested independently of this thin route. No direct table
// DML, no payout-lifecycle execution RPC (start_author_payout,
// finalize_author_payout, etc.), no provider SDK, no external money
// movement of any kind exists anywhere in this file or its helper
// module.

// ---------------------------------------------------------------------
// CRON_SECRET verification -- constant-time (Section 7).
//
// The existing reconciliation route compares the full
// "Bearer <secret>" header with plain `!==`. That route's own
// consequence of a timing side-channel succeeding is "an unauthorized
// caller can trigger one bounded Stripe reconciliation pass" -- already
// judged acceptable there. This route's reserve mode, once armed, can
// create real payout reservations, so this file adds a small,
// self-contained constant-time comparison rather than reusing the
// existing route's simple equality check. This is intentionally NOT a
// repo-wide auth refactor (Section 7's own explicit constraint) -- the
// existing route is untouched.
// ---------------------------------------------------------------------
function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    // Compare against itself so a length mismatch takes the same code
    // path/cost as a real comparison, rather than short-circuiting
    // (which would leak the expected length via timing) -- then
    // unconditionally reject.
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

// Authentication happens before anything else in both handlers below --
// before feature-switch state is read, before any mode is parsed, before
// createAdminClient() is ever called, before any financial data is
// touched (Section 6). The secret is accepted ONLY via the Authorization
// header, never a query string, request body, or cookie -- returning
// null here means "not even considered," not merely "not read."
function authenticate(request: Request): Response | null {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) {
    // Fails closed: an unconfigured secret must never be treated as
    // "no auth required." Never logs the (nonexistent) secret itself.
    console.error("payouts/run: CRON_SECRET is not configured -- refusing all requests");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const expected = `Bearer ${configuredSecret}`;
  if (!timingSafeEqualStrings(authHeader, expected)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  return null;
}

async function handleDryRunMode(): Promise<Response> {
  const supabase = createAdminClient();
  const result = await runDryRunPass(supabase);

  if (!result.ok) {
    console.error("[payout-scheduler] dry-run pass failed", { message: result.message });
    return NextResponse.json({ ok: false, mode: "dry-run", error: "Dry run failed" }, { status: 500 });
  }

  console.log("[payout-scheduler] dry-run pass complete", {
    mode: "dry-run",
    candidateCount: result.summary.candidateCount,
    eligibleCount: result.summary.eligibleCount,
    ineligibleCount: result.summary.ineligibleCount,
    totalsByCurrency: result.summary.totalsByCurrency,
  });

  return NextResponse.json({ ok: true, mode: "dry-run", ...result.summary });
}

// Reserve mode's ONE feature-switch check (Section 9/14): dry-run is
// intrinsically read-only and is never gated by
// PAYOUT_SCHEDULER_ENABLED at all (see handleDryRunMode above, called
// unconditionally) -- only THIS path, the one capable of real
// reservation mutation, is gated. When disabled, no admin client is
// created and no RPC of any kind is called -- the disabled response
// below is the entire code path.
async function handleReserveMode(targetMonth: string): Promise<Response> {
  const enabled = isSchedulerEnabled(process.env.PAYOUT_SCHEDULER_ENABLED);

  if (!enabled) {
    console.log("[payout-scheduler] reserve mode requested while disabled", { targetMonth });
    return NextResponse.json({ ok: true, mode: "reserve", enabled: false, targetMonth });
  }

  const supabase = createAdminClient();
  const result = await runReservationPass(supabase, targetMonth);

  if (!result.ok) {
    console.error("[payout-scheduler] reservation pass failed", {
      targetMonth,
      reason: result.reason,
      message: result.message,
      runId: result.runId,
      runKey: result.runKey,
      candidateCount: result.candidateCount,
      eligibleCount: result.eligibleCount,
      reservedCount: result.reservedCount,
      skippedCount: result.skippedCount,
      errorCount: result.errorCount,
      totalsByCurrency: result.totalsByCurrency,
    });
    // 500: the scheduled pass did not complete successfully -- never a
    // silent 200 over a run that stayed 'running' by omission
    // (Section 21).
    return NextResponse.json(
      { ok: false, mode: "reserve", enabled: true, targetMonth, reason: result.reason },
      { status: 500 },
    );
  }

  if (result.alreadyCompleted) {
    console.log("[payout-scheduler] reserve mode: run already completed", {
      targetMonth,
      runId: result.runId,
      runKey: result.runKey,
    });
    return NextResponse.json({
      ok: true,
      mode: "reserve",
      enabled: true,
      targetMonth,
      runId: result.runId,
      alreadyCompleted: true,
    });
  }

  console.log("[payout-scheduler] reserve mode: pass complete", {
    targetMonth,
    runId: result.runId,
    runKey: result.runKey,
    candidateCount: result.candidateCount,
    eligibleCount: result.eligibleCount,
    reservedCount: result.reservedCount,
    skippedCount: result.skippedCount,
    totalsByCurrency: result.totalsByCurrency,
  });

  return NextResponse.json({
    ok: true,
    mode: "reserve",
    enabled: true,
    targetMonth,
    runId: result.runId,
    alreadyCompleted: false,
    candidateCount: result.candidateCount,
    eligibleCount: result.eligibleCount,
    reservedCount: result.reservedCount,
    skippedCount: result.skippedCount,
    totalsByCurrency: result.totalsByCurrency,
  });
}

// GET is the future Vercel Cron entrypoint (Section 12, matching the
// reconciliation route's own GET-for-cron precedent): reserve mode, for
// the CURRENT Europe/Tirane calendar month, derived independently on
// every invocation -- never a cached/stale month. Until
// PAYOUT_SCHEDULER_ENABLED is explicitly set to "true" somewhere (not
// in this task), this is unconditionally the disabled no-op branch of
// handleReserveMode.
export async function GET(request: Request): Promise<Response> {
  const authFailure = authenticate(request);
  if (authFailure) return authFailure;

  const targetMonth = deriveTiranaTargetMonth();
  return handleReserveMode(targetMonth);
}

// POST supports exactly two explicit modes (Section 11) -- no hidden
// third behavior, no default mode when the field is missing/unknown.
export async function POST(request: Request): Promise<Response> {
  const authFailure = authenticate(request);
  if (authFailure) return authFailure;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
  }

  const mode = (body as { mode?: unknown }).mode;

  if (mode === "dry-run") {
    return handleDryRunMode();
  }

  if (mode === "reserve") {
    const targetMonth = parseStrictTargetMonth((body as { targetMonth?: unknown }).targetMonth);
    if (!targetMonth) {
      return NextResponse.json({ error: "Invalid targetMonth" }, { status: 400 });
    }
    return handleReserveMode(targetMonth);
  }

  return NextResponse.json({ error: "Invalid mode" }, { status: 400 });
}
