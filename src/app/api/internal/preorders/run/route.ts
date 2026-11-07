import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { maintenanceHttpResponse } from "@/lib/maintenance-response";
import { preorderDayCounts, runPreorderDay } from "@/lib/preorder-job";
import { sendPreorderJobEmails } from "@/lib/preorder-emails";
import { preorderJobMayRun } from "@/lib/preorder-staff";

// BD16 P5 (PLAN-BD16-r1 §3.5): the daily pre-order job, called by the
// two Vercel cron entries in vercel.json (06:00 and 07:00 UTC; the
// ?at= only tells the two entries apart and is not read; GET,
// "Authorization: Bearer <CRON_SECRET>"). Vercel runs crons only on
// Production; on staging the owner's "run now" button does the same.
// Tirana is UTC+1 or UTC+2, so the run before 08:00 Tirana does nothing
// and the one after does the day. Every step is safe to run twice:
// run_preorder_day reports each book only in the run that changed it,
// and each reader's email is claimed before it is sent
// (src/lib/preorder-emails.ts). Only counts are logged, never an id or
// an address.
//
// Authentication mirrors src/app/api/internal/tmp-uploads/cleanup:
// fail closed without CRON_SECRET, constant-time comparison.

export const maxDuration = 60;

const PREORDER_JOB_OFF_ENV = "PREORDER_JOB_OFF";

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
    console.error("preorders/run: CRON_SECRET is not configured -- refusing all requests");
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !timingSafeEqualStrings(authHeader, `Bearer ${configuredSecret}`)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: Request): Promise<Response> {
  const authFailure = authenticate(request);
  if (authFailure) return authFailure;

  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return maintenanceHttpResponse();
  }

  const off = process.env[PREORDER_JOB_OFF_ENV];
  if (typeof off === "string" && off.trim() !== "") {
    console.log("[preorders] switched off by PREORDER_JOB_OFF; nothing done");
    return NextResponse.json({ ok: true, off: true });
  }

  if (!preorderJobMayRun(new Date())) {
    console.log("[preorders] before 08:00 Tirana; nothing done");
    return NextResponse.json({ ok: true, tooEarly: true });
  }

  const admin = createAdminClient();
  const summary = await runPreorderDay(admin);
  const readers = await sendPreorderJobEmails(admin, summary);
  if (!summary) {
    console.error("[preorders] run failed", { readers });
    return NextResponse.json({ ok: false, readers }, { status: 500 });
  }
  const counts = preorderDayCounts(summary);
  console.log("[preorders] run complete", { today: summary.today, ...counts, readers });
  return NextResponse.json({ ok: true, today: summary.today, ...counts, readers });
}
