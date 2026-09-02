import { describe, expect, it } from "vitest";
import {
  REFUND_OPERATIONAL_STATE_LABELS,
  describeRefundOperationalState,
  describeNeedsAttention,
  describeDisputeStatus,
  describeCheckoutReconciliationReason,
  describeRefundEntitlementMismatch,
} from "./finance-logic";
import type { RefundOperationalState } from "@/lib/types";

describe("REFUND_OPERATIONAL_STATE_LABELS", () => {
  it("covers every RefundOperationalState value exactly once", () => {
    const states: RefundOperationalState[] = [
      "requested",
      "rejected",
      "refunded",
      "cancelled",
      "approved_unattempted",
      "approved_attempt_initiated",
      "approved_attempt_stale_initiated",
      "approved_attempt_unknown",
      "approved_attempt_failed",
      "approved_attempt_submitted",
    ];
    for (const state of states) {
      expect(REFUND_OPERATIONAL_STATE_LABELS[state]).toBeTypeOf("string");
      expect(REFUND_OPERATIONAL_STATE_LABELS[state].length).toBeGreaterThan(0);
    }
    expect(Object.keys(REFUND_OPERATIONAL_STATE_LABELS)).toHaveLength(states.length);
  });

  it("never says 'Refund failed' for an attempt-level failure -- only the ATTEMPT failed, the request remains approved", () => {
    expect(REFUND_OPERATIONAL_STATE_LABELS.approved_attempt_failed).toBe("Previous attempt failed");
    expect(REFUND_OPERATIONAL_STATE_LABELS.approved_attempt_failed).not.toContain("Refund failed");
  });

  it("never uses a generic 'Not issued' label for every approved sub-state -- each is distinct", () => {
    const approvedLabels = [
      REFUND_OPERATIONAL_STATE_LABELS.approved_unattempted,
      REFUND_OPERATIONAL_STATE_LABELS.approved_attempt_initiated,
      REFUND_OPERATIONAL_STATE_LABELS.approved_attempt_stale_initiated,
      REFUND_OPERATIONAL_STATE_LABELS.approved_attempt_unknown,
      REFUND_OPERATIONAL_STATE_LABELS.approved_attempt_failed,
      REFUND_OPERATIONAL_STATE_LABELS.approved_attempt_submitted,
    ];
    for (const label of approvedLabels) {
      expect(label).not.toBe("Not issued");
    }
    // Distinct in intent -- but stale-initiated and unknown deliberately
    // SHARE one label (both demand the identical staff action), so the
    // full set has 5 distinct strings across 6 states, not 6.
    expect(new Set(approvedLabels).size).toBe(5);
  });

  it("never claims 'Stripe was never called' for a stale-initiated or unknown attempt", () => {
    for (const state of ["approved_attempt_stale_initiated", "approved_attempt_unknown"] as const) {
      const label = REFUND_OPERATIONAL_STATE_LABELS[state];
      expect(label.toLowerCase()).not.toContain("never called");
      expect(label.toLowerCase()).not.toContain("safe to retry");
      expect(label).toBe("Attempt outcome needs reconciliation");
    }
  });

  it("distinguishes 'awaiting issuance' from 'in progress' from 'awaiting finalization' from 'completed'", () => {
    expect(REFUND_OPERATIONAL_STATE_LABELS.approved_unattempted).toBe("Approved — awaiting issuance");
    expect(REFUND_OPERATIONAL_STATE_LABELS.approved_attempt_initiated).toBe("Attempt in progress");
    expect(REFUND_OPERATIONAL_STATE_LABELS.approved_attempt_submitted).toBe("Submitted to Stripe — awaiting finalization");
    expect(REFUND_OPERATIONAL_STATE_LABELS.refunded).toBe("Refund completed");
  });

  it("never implies failure for a newly-approved, never-attempted refund -- ADMIN-1D Part B FINAL PRE-COMMIT CLASSIFICATION CORRECTION", () => {
    const label = REFUND_OPERATIONAL_STATE_LABELS.approved_unattempted;
    expect(label.toLowerCase()).not.toContain("fail");
    expect(label.toLowerCase()).not.toContain("overdue");
    expect(label.toLowerCase()).not.toContain("broken");
    expect(label).toBe("Approved — awaiting issuance");
  });
});

describe("describeRefundOperationalState", () => {
  it("returns the exact label for a given state", () => {
    expect(describeRefundOperationalState("approved_unattempted")).toBe("Approved — awaiting issuance");
    expect(describeRefundOperationalState("refunded")).toBe("Refund completed");
  });
});

describe("describeNeedsAttention", () => {
  it("labels true/false distinctly", () => {
    expect(describeNeedsAttention(true)).toBe("Needs attention");
    expect(describeNeedsAttention(false)).toBe("OK");
  });
});

describe("describeDisputeStatus", () => {
  it("labels every known terminal status", () => {
    expect(describeDisputeStatus("won")).toBe("Won");
    expect(describeDisputeStatus("lost")).toBe("Lost");
    expect(describeDisputeStatus("warning_closed")).toBe("Closed (early warning)");
    expect(describeDisputeStatus("charge_refunded")).toBe("Charge refunded");
  });

  it("labels a non-terminal status as an open dispute, never claiming a Stripe evidence deadline", () => {
    for (const status of ["needs_response", "under_review", "warning_needs_response", "warning_under_review"]) {
      const label = describeDisputeStatus(status);
      expect(label).toBe("Open dispute — review in Stripe");
      expect(label.toLowerCase()).not.toContain("evidence");
      expect(label.toLowerCase()).not.toContain("due");
      expect(label.toLowerCase()).not.toContain("response required");
    }
  });

  it("fails safe for an unrecognized future Stripe status -- treated as open, never silently terminal", () => {
    const label = describeDisputeStatus("some_future_stripe_status_2027");
    expect(label).toBe("Open dispute — review in Stripe");
  });
});

describe("describeCheckoutReconciliationReason", () => {
  it("labels every currently-allowed reconciliation_reason value", () => {
    expect(describeCheckoutReconciliationReason("active_other_session")).toContain("needs investigation");
    expect(describeCheckoutReconciliationReason("book_or_reader_deleted")).toContain("needs investigation");
    expect(describeCheckoutReconciliationReason("disputed_lost")).toContain("needs investigation");
  });

  it("never suggests a replay/retry action in any label", () => {
    const reasons = ["active_other_session", "book_or_reader_deleted", "disputed_lost", "some_unrecognized_reason"];
    for (const reason of reasons) {
      const label = describeCheckoutReconciliationReason(reason);
      expect(label.toLowerCase()).not.toContain("replay");
      expect(label.toLowerCase()).not.toContain("retry");
      expect(label.toLowerCase()).not.toContain("click");
    }
  });

  it("falls back to a generic, still-non-actionable label for an unrecognized reason", () => {
    expect(describeCheckoutReconciliationReason("some_unrecognized_reason")).toBe("Needs investigation");
  });

  it("preserves the deliberate business-decision meaning of disputed_lost distinctly from the others", () => {
    const disputedLabel = describeCheckoutReconciliationReason("disputed_lost");
    const otherLabel = describeCheckoutReconciliationReason("active_other_session");
    expect(disputedLabel).not.toBe(otherLabel);
  });
});

describe("describeRefundEntitlementMismatch", () => {
  it("labels every mismatch type distinctly", () => {
    const labels = [
      describeRefundEntitlementMismatch("refunded_request_active_purchase"),
      describeRefundEntitlementMismatch("refunded_request_active_bundle_snapshot"),
      describeRefundEntitlementMismatch("purchase_refunded_request_unresolved"),
    ];
    expect(new Set(labels).size).toBe(3);
    for (const label of labels) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
