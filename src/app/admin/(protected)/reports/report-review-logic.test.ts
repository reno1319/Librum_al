import { describe, expect, it } from "vitest";
import {
  canReview,
  compareForTriage,
  getReviewConfirmationMessage,
  mapReviewRpcError,
  resolveProfileDisplayName,
  validateAdminNotes,
  ADMIN_NOTES_MAX_LENGTH,
} from "./report-review-logic";
import type { BookReportStatus } from "@/lib/types";

describe("canReview", () => {
  it("open -> reviewable", () => {
    expect(canReview("open")).toBe(true);
  });
  it("resolved -> cannot be re-reviewed", () => {
    expect(canReview("resolved")).toBe(false);
  });
  it("dismissed -> cannot be re-reviewed", () => {
    expect(canReview("dismissed")).toBe(false);
  });
});

describe("compareForTriage", () => {
  type Row = { status: BookReportStatus; created_at: string; reviewed_at: string | null };

  it("puts every open report before every closed report", () => {
    const rows: Row[] = [
      { status: "resolved", created_at: "2026-01-01T00:00:00Z", reviewed_at: "2026-01-02T00:00:00Z" },
      { status: "open", created_at: "2026-01-05T00:00:00Z", reviewed_at: null },
      { status: "dismissed", created_at: "2026-01-01T00:00:00Z", reviewed_at: "2026-01-03T00:00:00Z" },
      { status: "open", created_at: "2026-01-04T00:00:00Z", reviewed_at: null },
    ];
    const sorted = [...rows].sort(compareForTriage);
    expect(sorted.slice(0, 2).every((r) => r.status === "open")).toBe(true);
    expect(sorted.slice(2).every((r) => r.status !== "open")).toBe(true);
  });

  it("orders open reports oldest-first (the longest-waiting report gets attention first)", () => {
    const rows: Row[] = [
      { status: "open", created_at: "2026-01-05T00:00:00Z", reviewed_at: null },
      { status: "open", created_at: "2026-01-01T00:00:00Z", reviewed_at: null },
      { status: "open", created_at: "2026-01-03T00:00:00Z", reviewed_at: null },
    ];
    const sorted = [...rows].sort(compareForTriage);
    expect(sorted.map((r) => r.created_at)).toEqual([
      "2026-01-01T00:00:00Z",
      "2026-01-03T00:00:00Z",
      "2026-01-05T00:00:00Z",
    ]);
  });

  it("orders closed reports most-recently-reviewed-first", () => {
    const rows: Row[] = [
      { status: "resolved", created_at: "2026-01-01T00:00:00Z", reviewed_at: "2026-01-02T00:00:00Z" },
      { status: "dismissed", created_at: "2026-01-01T00:00:00Z", reviewed_at: "2026-01-10T00:00:00Z" },
      { status: "resolved", created_at: "2026-01-01T00:00:00Z", reviewed_at: "2026-01-05T00:00:00Z" },
    ];
    const sorted = [...rows].sort(compareForTriage);
    expect(sorted.map((r) => r.reviewed_at)).toEqual([
      "2026-01-10T00:00:00Z",
      "2026-01-05T00:00:00Z",
      "2026-01-02T00:00:00Z",
    ]);
  });
});

describe("getReviewConfirmationMessage", () => {
  it("resolved: explicitly states this does not unpublish/take content action", () => {
    const message = getReviewConfirmationMessage("resolved");
    expect(message).toMatch(/does not unpublish the book/i);
  });

  it("dismissed: distinct, shorter copy", () => {
    const message = getReviewConfirmationMessage("dismissed");
    expect(message).not.toEqual(getReviewConfirmationMessage("resolved"));
  });
});

describe("validateAdminNotes", () => {
  it("accepts null (no notes field submitted)", () => {
    expect(validateAdminNotes(null)).toEqual({ ok: true, value: null });
  });

  it("trims and accepts a normal note", () => {
    expect(validateAdminNotes("  looks fine  ")).toEqual({ ok: true, value: "looks fine" });
  });

  it("treats a whitespace-only note as no note", () => {
    expect(validateAdminNotes("   ")).toEqual({ ok: true, value: null });
  });

  it("rejects a note over the max length", () => {
    const result = validateAdminNotes("x".repeat(ADMIN_NOTES_MAX_LENGTH + 1));
    expect(result.ok).toBe(false);
  });

  it("accepts a note exactly at the max length", () => {
    const result = validateAdminNotes("x".repeat(ADMIN_NOTES_MAX_LENGTH));
    expect(result.ok).toBe(true);
  });
});

describe("mapReviewRpcError", () => {
  it("maps the invalid-decision RPC message to friendly copy", () => {
    expect(
      mapReviewRpcError({ message: "p_decision must be 'resolved' or 'dismissed'" }),
    ).toBe("Invalid decision.");
  });

  it("maps the already-reviewed RPC message to friendly, specific copy", () => {
    expect(
      mapReviewRpcError({ message: "no reviewable report found for this id" }),
    ).toBe("This report has already been reviewed.");
  });

  it("maps the not-authorized RPC message to friendly copy", () => {
    expect(mapReviewRpcError({ message: "not authorized" })).toBe(
      "You don't have permission to review book reports.",
    );
  });

  it("falls back to the generic message for an unmapped/unexpected error -- never the raw text", () => {
    const raw = 'relation "public.book_reports" does not exist';
    const mapped = mapReviewRpcError({ message: raw });
    expect(mapped).toBe("We couldn't review this report. Please try again.");
    expect(mapped).not.toContain("relation");
  });

  it("falls back to the generic message when there is no error message at all", () => {
    expect(mapReviewRpcError(null)).toBe("We couldn't review this report. Please try again.");
    expect(mapReviewRpcError(undefined)).toBe("We couldn't review this report. Please try again.");
  });
});

describe("resolveProfileDisplayName", () => {
  const displayNameById = new Map([["user-1", "Jane Author"]]);

  it("resolves a known id", () => {
    expect(
      resolveProfileDisplayName({
        profileId: "user-1",
        displayNameById,
        whenNull: "none",
        whenMissing: "missing",
      }),
    ).toBe("Jane Author");
  });

  it("uses whenNull for a null id", () => {
    expect(
      resolveProfileDisplayName({
        profileId: null,
        displayNameById,
        whenNull: "Not yet reviewed",
        whenMissing: "missing",
      }),
    ).toBe("Not yet reviewed");
  });

  it("uses whenMissing for an id that didn't resolve", () => {
    expect(
      resolveProfileDisplayName({
        profileId: "user-404",
        displayNameById,
        whenNull: "none",
        whenMissing: "Unknown reporter (account no longer available)",
      }),
    ).toBe("Unknown reporter (account no longer available)");
  });
});
