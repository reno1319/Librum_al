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
} from "./refund-review-logic";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { redirectForMaintenance } from "@/lib/maintenance-response";

// requireStaff("refunds.resolve") here is defense in depth, not the
// actual security boundary -- Server Actions are independent server-side
// entry points that do NOT re-run the page/layout tree that rendered the
// form calling them, so src/app/admin/layout.tsx's own
// requireStaff("admin.access") gate (which protects every /admin/* page
// render) has no bearing on this function being invoked directly. The
// real authority is review_refund_request() itself (migration 029,
// re-gated to refunds.resolve by migration 040), which independently
// re-checks public.staff_has_permission('refunds.resolve') before doing
// anything -- this call exists so a staff member who lacks that specific
// permission (e.g. 'moderator', or 'support' who has refunds.view but not
// refunds.resolve) gets the same clean redirect experience as browsing to
// /admin directly, rather than a raw RPC rejection.
// ADMIN-1A: migrated from requireAdmin() to
// requireStaff("refunds.resolve").
export async function reviewRefundRequest(
  refundRequestId: string,
  decision: "approved" | "rejected",
  formData: FormData,
) {
  // ALL-CUTOVER APP-A: gated before requireStaff() and any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    redirectForMaintenance("/admin/refunds");
  }

  await requireStaff("refunds.resolve");

  const supabase = await createClient();

  if (!refundRequestId) {
    redirect(`/admin/refunds?error=${encodeURIComponent(GENERIC_REVIEW_ERROR_MESSAGE)}`);
  }

  const notesValidation = validateAdminNotes(formData.get("adminNotes"));
  if (!notesValidation.ok) {
    redirect(
      `/admin/refunds/${refundRequestId}?error=${encodeURIComponent(notesValidation.error)}`,
    );
  }

  // review_refund_request() is the sole authority here: it independently
  // re-derives the caller's identity from auth.uid(), re-checks
  // public.staff_has_permission('refunds.resolve'), re-validates the
  // decision value, re-checks the request is still in 'requested' status,
  // and writes reviewed_at/reviewed_by itself -- nothing computed
  // client-side (or in this action) is trusted for any of that. See
  // migrations 029 and 040.
  const { error } = await supabase.rpc("review_refund_request", {
    p_id: refundRequestId,
    p_decision: decision,
    p_admin_notes: notesValidation.value,
  });

  if (error) {
    if (error.message === REVIEW_RPC_NOT_AUTHENTICATED_MESSAGE) {
      redirect("/login?next=/admin/refunds");
    }
    redirect(
      `/admin/refunds/${refundRequestId}?error=${encodeURIComponent(mapReviewRpcError(error))}`,
    );
  }

  revalidatePath(`/admin/refunds/${refundRequestId}`);
  revalidatePath("/admin/refunds");
  redirect(
    `/admin/refunds/${refundRequestId}?success=${encodeURIComponent(
      decision === "approved" ? "Refund request approved." : "Refund request rejected.",
    )}`,
  );
}
