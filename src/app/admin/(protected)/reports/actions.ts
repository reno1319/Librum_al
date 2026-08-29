"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import {
  mapReviewRpcError,
  validateAdminNotes,
  GENERIC_REVIEW_ERROR_MESSAGE,
  REVIEW_RPC_NOT_AUTHENTICATED_MESSAGE,
} from "./report-review-logic";

// requireStaff("reports.resolve") here is defense in depth, not the
// actual security boundary -- Server Actions are independent server-side
// entry points that do NOT re-run the page/layout tree that rendered the
// form calling them, so src/app/admin/layout.tsx's own
// requireStaff("admin.access") gate has no bearing on this function being
// invoked directly. The real authority is review_book_report() itself
// (migration 039, re-gated to reports.resolve by migration 040), which
// independently re-derives the caller's identity from auth.uid() and
// re-checks public.staff_has_permission('reports.resolve') before doing
// anything -- this call exists so a staff member who lacks that specific
// permission (e.g. 'support') gets the same clean redirect experience as
// browsing to /admin directly, rather than a raw RPC rejection.
// ADMIN-1A: migrated from requireAdmin() to
// requireStaff("reports.resolve") -- narrower than the old admin.access
// gate could ever express, matching this action's actual authority.
// Exact mirror of reviewRefundRequest() (src/app/admin/refunds/
// actions.ts) -- see that file's own comment for the fuller reasoning,
// not repeated here.
//
// No redirectIfRecoverySessionActive() call, unlike issueStripeRefund()
// -- that guard exists specifically because issuing a refund is a real
// Stripe money-moving action; reviewing a report (like approving/
// rejecting a refund request) writes only administrative status and
// moves no money, matching reviewRefundRequest()'s own precedent
// exactly (which also has no recovery guard).
export async function reviewBookReport(
  reportId: string,
  decision: "resolved" | "dismissed",
  formData: FormData,
) {
  await requireStaff("reports.resolve");

  const supabase = await createClient();

  if (!reportId) {
    redirect(`/admin/reports?error=${encodeURIComponent(GENERIC_REVIEW_ERROR_MESSAGE)}`);
  }

  const notesValidation = validateAdminNotes(formData.get("adminNotes"));
  if (!notesValidation.ok) {
    redirect(`/admin/reports/${reportId}?error=${encodeURIComponent(notesValidation.error)}`);
  }

  // review_book_report() is the sole authority here: it independently
  // re-derives the caller's identity, re-checks
  // public.staff_has_permission('reports.resolve'), re-validates the
  // decision value, re-checks the report is still 'open', and writes
  // reviewed_at/reviewed_by itself -- nothing computed client-side (or in
  // this action) is trusted for any of that. See migrations 039 and 040.
  const { error } = await supabase.rpc("review_book_report", {
    p_id: reportId,
    p_decision: decision,
    p_admin_notes: notesValidation.value,
  });

  if (error) {
    if (error.message === REVIEW_RPC_NOT_AUTHENTICATED_MESSAGE) {
      redirect("/login?next=/admin/reports");
    }
    redirect(`/admin/reports/${reportId}?error=${encodeURIComponent(mapReviewRpcError(error))}`);
  }

  revalidatePath(`/admin/reports/${reportId}`);
  revalidatePath("/admin/reports");
  redirect(
    `/admin/reports/${reportId}?success=${encodeURIComponent(
      decision === "resolved" ? "Report resolved." : "Report dismissed.",
    )}`,
  );
}
