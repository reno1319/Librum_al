import type { RefundOperationalState, RefundEntitlementMismatchType } from "@/lib/types";

// ADMIN-1D Part B: pure, DOM-free formatting/label helpers for the
// finance read primitives (supabase/migrations/043_finance_
// reconciliation_reads.sql). No fetching, no Server Action, no
// component -- everything here takes already-fetched RPC data and
// produces display strings, mirroring audit-log-logic.ts's own split
// between data-shaping and data-fetching in this same admin area.
//
// No page.tsx exists yet for /admin/finance (ADMIN-1D Part B's own
// explicit scope boundary) -- this file exists so that later UI work has
// a stable, already-tested vocabulary to render from, exactly the same
// reasoning listAdminAuditEvents() documented for itself ahead of the
// /admin/audit page that came later.

// ============================================================
// Refund operational-state labels.
// ============================================================

// CRITICAL: matches operational_state's own wording rules exactly
// (ADMIN-1D Part B's own design brief, and the FINAL PRE-COMMIT
// CLASSIFICATION CORRECTION that followed it) --
//   - "Approved — awaiting issuance" for 'approved_unattempted'.
//     Deliberately NOT "Failed"/"Overdue"/"Broken", and not "Not issued"
//     either (that phrasing was rejected for implying every approved
//     request is somehow behind) -- refund_reconciliation_rows() (SQL)
//     flags this state's needs_attention = true IMMEDIATELY, with no
//     grace period, precisely because approving a refund and then never
//     issuing it is an incomplete administrative workflow Librum itself
//     already decided to complete -- not because anything has gone
//     wrong. This label must read as neutral/normal-workflow, matching
//     that intent exactly.
//   - "Attempt in progress" (a fresh 'initiated' attempt -- not yet
//     provably stuck).
//   - "Attempt outcome needs reconciliation" -- used for BOTH
//     'approved_attempt_stale_initiated' and 'approved_attempt_unknown'
//     deliberately. These are two different ROOT CAUSES (a stale
//     'initiated' row vs. a genuinely thrown/ambiguous Stripe call), but
//     from a staff member's perspective both demand the exact same
//     action: investigate via Stripe's own live refund-list lookup,
//     never blindly retry. The raw operational_state value still
//     distinguishes them precisely for anything that needs the
//     underlying difference (this label deliberately does not). Neither
//     is ever described as "safe, Stripe was never called" -- see this
//     type's own comment in src/lib/types.ts for why that would be
//     factually wrong.
//   - "Previous attempt failed" (never "Refund failed" -- the REQUEST
//     itself has no "failed" status at all; only an ATTEMPT can fail,
//     and the request remains 'approved', eligible for a fresh retry).
//   - "Submitted to Stripe — awaiting finalization" (Stripe accepted it;
//     Librum is waiting on its own webhook to settle the request). This
//     label does not change once the 1-hour operational triage threshold
//     passes -- the underlying needs_attention flag does, but a refund is
//     not "broken" merely for taking longer than the ordinary settlement
//     window; SQL's own comment (migration 043) is explicit that this
//     threshold is a triage heuristic, not a Stripe delivery guarantee.
//   - "Refund completed" (the request itself reached 'refunded').
export const REFUND_OPERATIONAL_STATE_LABELS: Record<RefundOperationalState, string> = {
  requested: "Requested",
  rejected: "Rejected",
  refunded: "Refund completed",
  cancelled: "Cancelled",
  approved_unattempted: "Approved — awaiting issuance",
  approved_attempt_initiated: "Attempt in progress",
  approved_attempt_stale_initiated: "Attempt outcome needs reconciliation",
  approved_attempt_unknown: "Attempt outcome needs reconciliation",
  approved_attempt_failed: "Previous attempt failed",
  approved_attempt_submitted: "Submitted to Stripe — awaiting finalization",
};

export function describeRefundOperationalState(state: RefundOperationalState): string {
  return REFUND_OPERATIONAL_STATE_LABELS[state];
}

export function describeNeedsAttention(needsAttention: boolean): string {
  return needsAttention ? "Needs attention" : "OK";
}

// ============================================================
// Dispute status labels.
// ============================================================

// The exact same terminal-status allow-list list_finance_disputes()
// itself uses to compute needs_attention (migration 043) -- kept here
// only for LABEL wording, never re-derives needs_attention itself (the
// RPC already returned that as its own boolean column; this never
// recomputes it).
const TERMINAL_DISPUTE_STATUS_LABELS: Record<string, string> = {
  won: "Won",
  lost: "Lost",
  warning_closed: "Closed (early warning)",
  charge_refunded: "Charge refunded",
};

// Deliberately does NOT claim any Stripe evidence deadline --
// payment_disputes stores no evidence_due_by/needs_response column
// (confirmed: not part of this table), so no such fact could ever be
// derived here even if this function tried. A non-terminal/unrecognized
// status is always "Open dispute — review in Stripe", never "Evidence
// due" or "Response required by <date>".
export function describeDisputeStatus(status: string): string {
  return TERMINAL_DISPUTE_STATUS_LABELS[status] ?? "Open dispute — review in Stripe";
}

// ============================================================
// Checkout reconciliation-reason labels.
// ============================================================

// Every reconciliation_reason value book_checkout_intents' own CHECK
// constraint currently allows (migration 032/035). Each label frames the
// row as a deliberate, already-made business outcome to investigate --
// never as a broken payment to "replay." No mutation/action verb
// anywhere in this vocabulary, on purpose (ADMIN-1D Part B builds no
// recovery action for this at all).
const CHECKOUT_RECONCILIATION_REASON_LABELS: Record<string, string> = {
  active_other_session: "Reader already had another active purchase for this book — needs investigation",
  book_or_reader_deleted: "The book or reader account was deleted before fulfillment — needs investigation",
  disputed_lost: "Blocked: this payment's dispute was lost — needs investigation",
};

export function describeCheckoutReconciliationReason(reason: string): string {
  return CHECKOUT_RECONCILIATION_REASON_LABELS[reason] ?? "Needs investigation";
}

// ============================================================
// Refund/entitlement mismatch labels.
// ============================================================

const MISMATCH_TYPE_LABELS: Record<RefundEntitlementMismatchType, string> = {
  refunded_request_active_purchase: "Refund request marked refunded, but the purchase is still active",
  refunded_request_active_bundle_snapshot: "Refund request marked refunded, but the bundle purchase is still active",
  purchase_refunded_request_unresolved: "Purchase is refunded, but its refund request has not been marked refunded",
};

export function describeRefundEntitlementMismatch(type: RefundEntitlementMismatchType): string {
  return MISMATCH_TYPE_LABELS[type];
}
