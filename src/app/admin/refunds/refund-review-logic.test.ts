import { describe, expect, it } from "vitest";
import {
  abbreviatePaymentIntentId,
  canIssueRefund,
  canReview,
  compareForTriage,
  getIssueRefundConfirmationMessage,
  getReviewConfirmationMessage,
  mapReviewRpcError,
  resolveProfileDisplayName,
  validateAdminNotes,
  ADMIN_NOTES_MAX_LENGTH,
  GENERIC_REVIEW_ERROR_MESSAGE,
} from "./refund-review-logic";

describe("resolveProfileDisplayName", () => {
  it("returns the resolved display name when the profile is present", () => {
    const displayNameById = new Map([["user-1", "Alice"]]);
    expect(
      resolveProfileDisplayName({
        profileId: "user-1",
        displayNameById,
        whenNull: "No reviewer yet",
        whenMissing: "Unknown reviewer",
      }),
    ).toBe("Alice");
  });

  it("returns whenNull when the id itself is null (e.g. reviewed_by not yet set)", () => {
    expect(
      resolveProfileDisplayName({
        profileId: null,
        displayNameById: new Map(),
        whenNull: "No reviewer yet",
        whenMissing: "Unknown reviewer",
      }),
    ).toBe("No reviewer yet");
  });

  it("returns whenMissing when the id is set but no matching profile was found", () => {
    expect(
      resolveProfileDisplayName({
        profileId: "user-deleted",
        displayNameById: new Map(),
        whenNull: "No reviewer yet",
        whenMissing: "Unknown reviewer",
      }),
    ).toBe("Unknown reviewer");
  });
});

describe("getReviewConfirmationMessage", () => {
  it("clarifies that approval does not issue the Stripe refund", () => {
    const message = getReviewConfirmationMessage("approved");
    expect(message).toContain("Approve this refund request?");
    expect(message).toContain("does not issue the Stripe refund yet");
  });

  it("uses distinct, simpler copy for rejection with no refund-status claim", () => {
    const message = getReviewConfirmationMessage("rejected");
    expect(message).toBe("Reject this refund request?");
  });

  it("produces two genuinely different messages for the two decisions", () => {
    expect(getReviewConfirmationMessage("approved")).not.toBe(
      getReviewConfirmationMessage("rejected"),
    );
  });
});

describe("abbreviatePaymentIntentId", () => {
  it("shortens a typical Stripe payment intent id to a recognizable prefix/suffix", () => {
    expect(abbreviatePaymentIntentId("pi_3P8x9K2eZvKYlo2C1abcdefg")).toBe("pi_3P8x9…defg");
  });

  it("leaves a short id untouched", () => {
    expect(abbreviatePaymentIntentId("pi_short")).toBe("pi_short");
  });
});

describe("canReview", () => {
  it("allows review only when status is requested", () => {
    expect(canReview("requested")).toBe(true);
  });

  it("disallows review for every other status", () => {
    expect(canReview("approved")).toBe(false);
    expect(canReview("rejected")).toBe(false);
    expect(canReview("refunded")).toBe(false);
    expect(canReview("cancelled")).toBe(false);
  });
});

describe("canIssueRefund", () => {
  it("allows issuing a refund only when status is approved", () => {
    expect(canIssueRefund("approved")).toBe(true);
  });

  it("disallows issuing a refund for every other status", () => {
    expect(canIssueRefund("requested")).toBe(false);
    expect(canIssueRefund("rejected")).toBe(false);
    expect(canIssueRefund("refunded")).toBe(false);
    expect(canIssueRefund("cancelled")).toBe(false);
  });
});

describe("getIssueRefundConfirmationMessage", () => {
  it("formats the amount as dollars and cents and states the consequence is irreversible", () => {
    expect(getIssueRefundConfirmationMessage(699)).toBe(
      "Issue the $6.99 refund through Stripe? This will return the payment to the reader. This action cannot be undone.",
    );
  });

  it("formats a whole-dollar amount with two decimal places", () => {
    expect(getIssueRefundConfirmationMessage(500)).toContain("$5.00");
  });
});

describe("compareForTriage", () => {
  it("sorts a requested item before a non-requested item regardless of date", () => {
    const requested = { status: "requested" as const, requested_at: "2026-01-01T00:00:00.000Z" };
    const approved = { status: "approved" as const, requested_at: "2026-01-05T00:00:00.000Z" };
    const sorted = [approved, requested].sort(compareForTriage);
    expect(sorted).toEqual([requested, approved]);
  });

  it("orders two requested items by most recent first", () => {
    const older = { status: "requested" as const, requested_at: "2026-01-01T00:00:00.000Z" };
    const newer = { status: "requested" as const, requested_at: "2026-01-05T00:00:00.000Z" };
    const sorted = [older, newer].sort(compareForTriage);
    expect(sorted).toEqual([newer, older]);
  });

  it("orders two non-requested items by most recent first as well", () => {
    const older = { status: "rejected" as const, requested_at: "2026-01-01T00:00:00.000Z" };
    const newer = { status: "cancelled" as const, requested_at: "2026-01-05T00:00:00.000Z" };
    const sorted = [older, newer].sort(compareForTriage);
    expect(sorted).toEqual([newer, older]);
  });
});

describe("validateAdminNotes", () => {
  it("accepts a null value (notes are optional, matching the RPC)", () => {
    expect(validateAdminNotes(null)).toEqual({ ok: true, value: null });
  });

  it("treats an empty/whitespace-only value as no notes", () => {
    expect(validateAdminNotes("   ")).toEqual({ ok: true, value: null });
  });

  it("trims and accepts notes within the limit", () => {
    expect(validateAdminNotes("  looks legitimate  ")).toEqual({
      ok: true,
      value: "looks legitimate",
    });
  });

  it("rejects notes over the 2000-character limit", () => {
    const tooLong = "a".repeat(ADMIN_NOTES_MAX_LENGTH + 1);
    expect(validateAdminNotes(tooLong).ok).toBe(false);
  });

  it("accepts notes at exactly the 2000-character limit", () => {
    const exact = "a".repeat(ADMIN_NOTES_MAX_LENGTH);
    expect(validateAdminNotes(exact)).toEqual({ ok: true, value: exact });
  });
});

describe("mapReviewRpcError", () => {
  it("maps the not-authorized exception to admin-facing copy", () => {
    expect(mapReviewRpcError({ message: "not authorized" })).toBe(
      "You don't have permission to review refund requests.",
    );
  });

  it("maps the no-longer-reviewable exception to admin-facing copy", () => {
    expect(
      mapReviewRpcError({ message: "no reviewable refund request found for this id" }),
    ).toContain("no longer awaiting review");
  });

  it("falls back to a generic message for an unrecognized error, never leaking raw Postgres text", () => {
    expect(
      mapReviewRpcError({
        message: 'duplicate key value violates unique constraint "refund_requests_pkey"',
      }),
    ).toBe(GENERIC_REVIEW_ERROR_MESSAGE);
  });

  it("falls back to a generic message for a null/empty error", () => {
    expect(mapReviewRpcError(null)).toBe(GENERIC_REVIEW_ERROR_MESSAGE);
    expect(mapReviewRpcError({ message: "" })).toBe(GENERIC_REVIEW_ERROR_MESSAGE);
  });
});
