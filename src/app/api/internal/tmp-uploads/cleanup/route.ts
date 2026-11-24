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
import { alertIfCronFailed } from "@/lib/error-alerts";
import { BLOG_IMAGE_BUCKET, runBlogImageCleanup } from "@/lib/blog-image-cleanup";

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

async function runJob(request: Request): Promise<Response> {
  const authFailure = authenticate(request);
  if (authFailure) return authFailure;

  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return maintenanceHttpResponse();
  }

  if (isTmpCleanupOff(process.env[TMP_CLEANUP_OFF_ENV])) {
    console.log("[tmp-cleanup] switched off by TMP_CLEANUP_OFF; nothing done");
    return NextResponse.json({ ok: true, off: true });
  }

  const admin = createAdminClient();
  const bucket = admin.storage.from(TMP_CLEANUP_BUCKET);
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

  // G2 (c1 a): blog pictures no post uses, in the same nightly run
  // (src/lib/blog-image-cleanup.ts). Counts only in the logs.
  const blogBucket = admin.storage.from(BLOG_IMAGE_BUCKET);
  const blogImages = await runBlogImageCleanup(
    {
      list: (prefix, offset, limit) =>
        blogBucket.list(prefix, { limit, offset, sortBy: { column: "name", order: "asc" } }),
      remove: (keys) => blogBucket.remove(keys),
      // Every post in every state. The exact count must match the rows
      // returned, so a capped or partial answer removes nothing.
      async loadPostTexts() {
        const { data, error, count } = await admin
          .from("blog_posts")
          .select("content_markdown", { count: "exact" })
          .range(0, 4999);
        if (error || !Array.isArray(data) || count !== data.length) return null;
        const texts = data.map((row: { content_markdown: unknown }) => row.content_markdown);
        return texts.every((t): t is string => typeof t === "string") ? texts : null;
      },
    },
    Date.now(),
  );
  if (!blogImages.ok) {
    console.error("[blog-image-cleanup] run failed", blogImages);
    return NextResponse.json({ ...summary, blogImages }, { status: 500 });
  }
  console.log("[blog-image-cleanup] run complete", blogImages);
  return NextResponse.json({ ...summary, blogImages });
}

// ALERTS-2: the cron entrypoint. A failed run (5xx) emails the team
// (src/lib/error-alerts.ts alertIfCronFailed); the response is unchanged.
export async function GET(request: Request): Promise<Response> {
  return alertIfCronFailed("/api/internal/tmp-uploads/cleanup", await runJob(request));
}
