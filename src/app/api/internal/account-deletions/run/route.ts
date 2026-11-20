import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { maintenanceHttpResponse } from "@/lib/maintenance-response";
import { runDueAccountDeletions } from "@/lib/account-deletion";
import { alertIfCronFailed } from "@/lib/error-alerts";

// DEL (Renato 11-18): the daily real deletion of accounts whose 30 days
// to change their mind are over, called by the Vercel cron in
// vercel.json (GET, "Authorization: Bearer <CRON_SECRET>"). Vercel runs
// crons only on Production deployments. The job itself is
// src/lib/account-deletion.ts; this route only authenticates, honours
// the maintenance switch and logs counts (never an account id).
//
// Authentication mirrors src/app/api/internal/tmp-uploads/cleanup/route.ts:
// fail closed without CRON_SECRET, constant-time comparison.

export const maxDuration = 60;

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

function authenticate(request: Request): Response | null {
  const configuredSecret = process.env.CRON_SECRET;
  if (!configuredSecret) {
    console.error("account-deletions/run: CRON_SECRET is not configured -- refusing all requests");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !timingSafeEqualStrings(authHeader, `Bearer ${configuredSecret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

async function runJob(request: Request): Promise<Response> {
  const authFailure = authenticate(request);
  if (authFailure) return authFailure;

  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return maintenanceHttpResponse();
  }

  const run = await runDueAccountDeletions(createAdminClient());
  if (!run.ok) {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
  console.log("[account-deletions] run complete", run.counts);
  return NextResponse.json(run);
}

// ALERTS-2: the cron entrypoint. A failed run (5xx) emails the team
// (src/lib/error-alerts.ts alertIfCronFailed); the response is unchanged.
export async function GET(request: Request): Promise<Response> {
  return alertIfCronFailed("/api/internal/account-deletions/run", await runJob(request));
}
