import type { RefundRequestStatus } from "@/lib/types";

// Matches refund_requests.admin_notes's own cap, enforced by
// review_refund_request() itself (migration 029:
// `if p_admin_notes is not null and pg_catalog.char_length(p_admin_notes)
// > 2000 then raise exception ...`). Mirrored here only so the UI can
// give a friendly message before submission -- the RPC's own check
// remains the actual authority.
export const ADMIN_NOTES_MAX_LENGTH = 2000;

export const REVIEW_STATUS_LABELS: Record<RefundRequestStatus, string> = {
  requested: "Requested",
  approved: "Approved",
  rejected: "Rejected",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

// A request only ever exposes Approve/Reject controls in the 'requested'
// state -- review_refund_request() (migration 029) only ever transitions
// a row `where status = 'requested'`; every other status is a dead end
// for this RPC (approved/rejected are terminal for it, refunded is
// service-role/webhook-only and unreachable through any authenticated
// path, cancelled is the reader's own terminal state). This is
// presentational only: the RPC re-checks the current status itself and
// is what actually decides whether a transition is legal, regardless of
// what this function says.
export function canReview(status: RefundRequestStatus): boolean {
  return status === "requested";
}

// The "Issue refund" control (Phase REFUND-1B Step 5) only ever appears
// for a request currently 'approved' -- 'requested' still needs
// Approve/Reject first, and 'rejected'/'cancelled'/'refunded' are all
// terminal from this action's perspective (a refunded request has
// nothing left to issue; the other two were never approved to begin
// with). Presentational only, exactly like canReview() above:
// executeApprovedRefund() (src/app/admin/refunds/issue-refund.ts)
// independently re-checks the request's CURRENT status before ever
// calling Stripe, and is what actually decides whether execution is
// legal -- this function only decides whether the button renders.
export function canIssueRefund(status: RefundRequestStatus): boolean {
  return status === "approved";
}

// Confirmation copy for the "Issue refund" button
// (src/app/admin/refunds/[id]/issue-refund-button.tsx) -- extracted as a
// pure function for the same reason as getReviewConfirmationMessage
// above: directly testable without a DOM/browser testing setup. The
// amount shown here comes from the already-rendered, server-fetched
// refund_requests.amount_cents -- purely for the admin's own
// information before they decide whether to proceed. It plays no role
// in what Stripe actually refunds: executeApprovedRefund() never passes
// an amount to Stripe at all (see its own documentation for why),
// so this confirmation text can never be more (or less) authoritative
// than what actually happens next.
export function getIssueRefundConfirmationMessage(amountCents: number): string {
  const amount = (amountCents / 100).toFixed(2);
  return `Issue the $${amount} refund through Stripe? This will return the payment to the reader. This action cannot be undone.`;
}

// Sorts requested (actionable) items first, then by most recently
// requested within each group -- pure triage ordering, no bearing on
// what any request is actually allowed to do.
export function compareForTriage<T extends { status: RefundRequestStatus; requested_at: string }>(
  a: T,
  b: T,
): number {
  const aPending = a.status === "requested" ? 0 : 1;
  const bPending = b.status === "requested" ? 0 : 1;
  if (aPending !== bPending) {
    return aPending - bPending;
  }
  return a.requested_at < b.requested_at ? 1 : a.requested_at > b.requested_at ? -1 : 0;
}

// A safe, abbreviated form of a Stripe PaymentIntent id for display --
// enough for an admin to recognize/cross-reference it (e.g. against the
// Stripe Dashboard) without printing the full identifier in a list view.
export function abbreviatePaymentIntentId(id: string): string {
  if (id.length <= 14) {
    return id;
  }
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

// Shared resolution for both reader_id and reviewed_by -- both are
// nullable references to profiles (ON DELETE SET NULL, migration 029),
// and both can also point at a still-referenced id whose profiles row
// PostgREST simply won't return if it was somehow filtered out (it
// won't be here in practice, since profiles is fully public-readable --
// "Profiles are viewable by everyone" -- but this stays defensive
// either way rather than assuming a Map.get() always hits). whenNull
// and whenMissing are separate messages on purpose: a null id is a
// different, more definite fact ("no reviewer yet" / "account deleted")
// than an id that's set but didn't resolve (which shouldn't normally
// happen here, but is handled the same honest way as every other
// "missing related record" case in this app rather than crashing).
export function resolveProfileDisplayName(params: {
  profileId: string | null;
  displayNameById: Map<string, string>;
  whenNull: string;
  whenMissing: string;
}): string {
  if (!params.profileId) {
    return params.whenNull;
  }
  return params.displayNameById.get(params.profileId) ?? params.whenMissing;
}

// Confirmation copy for the approve/reject buttons (src/app/admin/
// refunds/[id]/review-buttons.tsx) -- extracted as a pure function so
// the two messages' distinct wording is directly testable without a
// DOM/browser testing setup. The approval message exists specifically
// to prevent the "approved implies refunded" misunderstanding Step 3 is
// required to avoid everywhere: approving here only ever calls
// review_refund_request(), which writes status = 'approved' and
// nothing else -- no purchases/snapshot/Stripe state changes as a
// result, so the confirmation says so explicitly rather than implying
// otherwise.
export function getReviewConfirmationMessage(decision: "approved" | "rejected"): string {
  if (decision === "approved") {
    return "Approve this refund request? This records administrative approval but does not issue the Stripe refund yet.";
  }
  return "Reject this refund request?";
}

export type AdminNotesValidation = { ok: true; value: string | null } | { ok: false; error: string };

// admin_notes is optional on the RPC side (p_admin_notes accepts null,
// and there is no "rejection requires notes" rule anywhere in
// review_refund_request()) -- this only ever rejects notes that are too
// long, matching the RPC's own 2000-character check, so a submission
// that would fail server-side gets a friendly client-side message
// instead of a raw exception.
export function validateAdminNotes(raw: FormDataEntryValue | null): AdminNotesValidation {
  if (raw == null) {
    return { ok: true, value: null };
  }
  const trimmed = String(raw).trim();
  if (trimmed.length === 0) {
    return { ok: true, value: null };
  }
  if (trimmed.length > ADMIN_NOTES_MAX_LENGTH) {
    return {
      ok: false,
      error: `Please keep notes under ${ADMIN_NOTES_MAX_LENGTH} characters.`,
    };
  }
  return { ok: true, value: trimmed };
}

export const GENERIC_REVIEW_ERROR_MESSAGE = "Something went wrong. Please try again.";

// The exact strings review_refund_request() raises via
// `raise exception '...'` in migration 029. 'not authenticated' is
// handled as a special case by the caller (redirect to login), not
// through the generic mapping below, for the same reason as the reader
// flow's RPC_NOT_AUTHENTICATED_MESSAGE (src/app/library/refund-logic.ts).
export const REVIEW_RPC_NOT_AUTHENTICATED_MESSAGE = "not authenticated";

// Every other exception message the RPC can raise, mapped to
// admin-facing copy. Deliberately NOT a passthrough of error.message --
// see mapRefundRpcError's own reasoning in
// src/app/library/refund-logic.ts for why: anything not in this list
// falls through to GENERIC_REVIEW_ERROR_MESSAGE rather than ever
// reaching the browser.
const KNOWN_REVIEW_RPC_ERROR_MESSAGES: Record<string, string> = {
  "not authorized": "You don't have permission to review refund requests.",
  "p_decision must be 'approved' or 'rejected'": "Invalid decision.",
  "p_admin_notes must be 2000 characters or fewer": `Notes must be ${ADMIN_NOTES_MAX_LENGTH} characters or fewer.`,
  "no reviewable refund request found for this id":
    "This request is no longer awaiting review -- it may have already been reviewed or cancelled.",
};

export function mapReviewRpcError(error: { message?: string | null } | null | undefined): string {
  const message = error?.message?.trim();
  if (!message) {
    return GENERIC_REVIEW_ERROR_MESSAGE;
  }
  return KNOWN_REVIEW_RPC_ERROR_MESSAGES[message] ?? GENERIC_REVIEW_ERROR_MESSAGE;
}
