"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth";
import { stripe } from "@/lib/stripe";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";
import {
  mapReviewRpcError,
  validateAdminNotes,
  GENERIC_REVIEW_ERROR_MESSAGE,
  REVIEW_RPC_NOT_AUTHENTICATED_MESSAGE,
  REFUND_SUBMITTED_SUCCESS_MESSAGE,
} from "./refund-review-logic";
import { executeApprovedRefund } from "./issue-refund";

// requireAdmin() here is defense in depth, not the actual security
// boundary -- Server Actions are independent server-side entry points
// that do NOT re-run the page/layout tree that rendered the form
// calling them, so src/app/admin/layout.tsx's own requireAdmin() gate
// (which protects every /admin/* page render) has no bearing on this
// function being invoked directly. The real authority is
// review_refund_request() itself (migration 029), which independently
// re-checks public.is_admin() before doing anything -- this call exists
// so a non-admin caller gets the same clean redirect experience as
// browsing to /admin directly, rather than a raw RPC rejection.
export async function reviewRefundRequest(
  refundRequestId: string,
  decision: "approved" | "rejected",
  formData: FormData,
) {
  await requireAdmin();

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
  // re-derives the admin's identity from auth.uid(), re-checks
  // public.is_admin(), re-validates the decision value, re-checks the
  // request is still in 'requested' status, and writes reviewed_at/
  // reviewed_by itself -- nothing computed client-side (or in this
  // action) is trusted for any of that. See migration 029.
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

// requireAdmin() here is the same defense-in-depth pattern as
// reviewRefundRequest() above, for the same reason (Server Actions
// bypass the page/layout tree). The actual gate against a non-admin
// executing a real Stripe refund is executeApprovedRefund() re-fetching
// the request through the request-scoped, RLS-respecting client below
// -- no service-role/admin Supabase client is used anywhere in this
// action. It was audited and found unnecessary: this action never
// writes to any Supabase table (Stripe execution and Librum's own
// refund-request/entitlement bookkeeping are deliberately kept
// separate -- see issue-refund.ts's own documentation), and the one
// read it performs (refund_requests by id) is already covered by
// migration 029's "Admins can view all refund requests" RLS policy plus
// its accompanying `grant select ... to authenticated`. Stripe's secret
// key is only ever read server-side via src/lib/stripe.ts, imported
// here in a "use server" file -- never reachable from client code.
export async function issueStripeRefund(refundRequestId: string) {
  await requireAdmin();
  // LAUNCH-1 P1-11: defense-in-depth -- Proxy already blocks every
  // /admin/* page while a recovery session is active, so this is the
  // second layer against a crafted direct POST. Applies even to an
  // admin's own account: if THIS admin is currently mid-recovery, they
  // must finish that before performing any action, including this one
  // -- the security invariant makes no role-based exception. Runs
  // before the real Stripe refund call below.
  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const outcome = await executeApprovedRefund(supabase, stripe, refundRequestId);

  switch (outcome.kind) {
    case "not_found":
      redirect(`/admin/refunds?error=${encodeURIComponent(GENERIC_REVIEW_ERROR_MESSAGE)}`);
      break;
    case "not_approved":
      redirect(
        `/admin/refunds/${refundRequestId}?error=${encodeURIComponent(
          "This request is no longer approved -- it may have already been refunded, rejected, or cancelled.",
        )}`,
      );
      break;
    case "stripe_error":
      redirect(
        `/admin/refunds/${refundRequestId}?error=${encodeURIComponent(outcome.message)}`,
      );
      break;
    case "submitted":
      // Deliberately does NOT say "Refunded" -- Stripe accepting this
      // call means only that the refund was initiated. The Stripe
      // webhook (processChargeRefund, gated by
      // isChargeFullyRefundedBySucceededRefunds -- see route.ts) remains
      // the sole writer of purchases.refunded_at,
      // bundle_checkout_snapshots.refunded_at, and refund_requests.
      // status = 'refunded'/refunded_at -- nothing here touches any of
      // those. If that webhook has already landed by the time this page
      // re-renders (a real, possible race: Stripe can deliver
      // charge.refunded before this redirect even completes), the
      // request's own status badge on the page -- re-read fresh on every
      // render, independent of this banner -- will already correctly
      // show "Refunded"; this transient message is only ever a
      // same-request confirmation that the click worked, never the
      // source of truth for current status. The page itself now also
      // rewrites this exact message to REFUND_CONFIRMED_SUCCESS_MESSAGE
      // when it detects that race (status already 'refunded' by the
      // time this redirect is rendered) -- see
      // resolveSuccessBannerMessage in refund-review-logic.ts -- so the
      // banner and the badge can never visibly disagree.
      //
      // This same "waiting for confirmation" wording is used for EVERY
      // "submitted" outcome, including an immediate refund.status ===
      // 'succeeded' response from Stripe (see executeApprovedRefund in
      // issue-refund.ts) -- explicitly confirmed correct, not an
      // oversight: even a refund Stripe reports as already 'succeeded'
      // at creation time has not yet been confirmed by Librum's own
      // webhook, which independently re-verifies terminal success before
      // writing anything (see isChargeFullyRefundedBySucceededRefunds).
      // "Waiting for confirmation" is accurate regardless of how quickly
      // that confirmation actually arrives.
      revalidatePath(`/admin/refunds/${refundRequestId}`);
      revalidatePath("/admin/refunds");
      redirect(
        `/admin/refunds/${refundRequestId}?success=${encodeURIComponent(
          REFUND_SUBMITTED_SUCCESS_MESSAGE,
        )}`,
      );
      break;
  }
}
