import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { maintenanceHttpResponse } from "@/lib/maintenance-response";
import {
  isTmpCleanupOff,
  runTmpUploadCleanup,
  TMP_CLEANUP_BUCKET,
  TMP_CLEANUP_OFF_ENV,
  type TmpCleanupStorage,
} from "@/lib/tmp-upload-cleanup";

// BD5 (W9): the daily clean-up of abandoned temporary uploads, called
// by the Vercel cron in vercel.json (GET, "Authorization: Bearer
// <CRON_SECRET>"). Vercel runs crons only on Production deployments.
// The job itself is src/lib/tmp-upload-cleanup.ts; this route only
// authenticates, honours the maintenance and off switches, and logs the
// counts (never a storage key, so no account id reaches the logs).
//
// Authentication mirrors src/app/api/internal/payouts/run/route.ts:
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
    console.error("tmp-uploads/cleanup: CRON_SECRET is not configured -- refusing all requests");
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

  if (isTmpCleanupOff(process.env[TMP_CLEANUP_OFF_ENV])) {
    console.log("[tmp-cleanup] switched off by TMP_CLEANUP_OFF; nothing done");
    return NextResponse.json({ ok: true, off: true });
  }

  const bucket = createAdminClient().storage.from(TMP_CLEANUP_BUCKET);
  const storage: TmpCleanupStorage = {
    list: (prefix, offset, limit) =>
      bucket.list(prefix, { limit, offset, sortBy: { column: "name", order: "asc" } }),
    remove: (keys) => bucket.remove(keys),
  };

  const summary = await runTmpUploadCleanup(storage, Date.now());
  if (!summary.ok) {
    console.error("[tmp-cleanup] run failed", summary);
    return NextResponse.json(summary, { status: 500 });
  }
  console.log("[tmp-cleanup] run complete", summary);
  return NextResponse.json(summary);
}
