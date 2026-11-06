"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { redirectForMaintenance } from "@/lib/maintenance-response";
import { after } from "next/server";
import { preorderDayCounts, runPreorderDay } from "@/lib/preorder-job";
import { sendPreorderJobEmails } from "@/lib/preorder-emails";
import {
  PREORDER_RUN_FAILED_MESSAGE,
  PREORDER_RUN_OWNER_ONLY_MESSAGE,
  PREORDER_RUN_TOO_EARLY_MESSAGE,
  encodeRunCounts,
  preorderJobMayRun,
} from "@/lib/preorder-staff";

// BD16 P3 (PLAN-BD16-r1 §3.5): the owner's "Run the pre-order job now"
// on the Today page. Vercel never runs crons on Preview, so this is how
// staging is tested, and the fallback when a Production run is missed.
// The maintenance gate, then requireStaff + the owner check (the role
// is read on the server, never from the form), then the 08:00 Tirana
// rule (Renato 11-06: a file sent before the 08:00 job counts as on
// time), then run_preorder_day with the service-role client (granted to
// service_role only). The database step is safe to run twice. BD16 P5:
// the emails (src/lib/preorder-emails.ts) go after the page has answered;
// the readers' sweep runs even when the database step failed.
export async function runPreorderJobAsOwner() {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin");
  }

  const { role } = await requireStaff("admin.access");
  if (role !== "owner") {
    redirect(`/admin?error=${encodeURIComponent(PREORDER_RUN_OWNER_ONLY_MESSAGE)}`);
  }

  if (!preorderJobMayRun(new Date())) {
    redirect(`/admin?error=${encodeURIComponent(PREORDER_RUN_TOO_EARLY_MESSAGE)}`);
  }

  const admin = createAdminClient();
  const summary = await runPreorderDay(admin);
  try {
    after(async () => {
      try {
        await sendPreorderJobEmails(admin, summary);
      } catch (sendError) {
        console.error("runPreorderJobAsOwner: the pre-order emails failed", { error: sendError });
      }
    });
  } catch (scheduleError) {
    console.error("runPreorderJobAsOwner: the pre-order emails could not be scheduled", { error: scheduleError });
  }
  if (!summary) {
    redirect(`/admin?error=${encodeURIComponent(PREORDER_RUN_FAILED_MESSAGE)}`);
  }

  const changed = [...summary.releasedBookIds, ...summary.cancelledBookIds, ...summary.slipped.map((s) => s.bookId)];
  for (const path of new Set(["/", "/librari", "/admin", "/admin/books", "/dashboard", ...changed.map((id) => `/libra/${id}`)])) {
    try {
      revalidatePath(path);
    } catch (revalidateError) {
      console.error("runPreorderJobAsOwner: revalidatePath failed", { path, error: revalidateError });
    }
  }

  redirect(`/admin?preorderRun=${encodeRunCounts(preorderDayCounts(summary))}`);
}
