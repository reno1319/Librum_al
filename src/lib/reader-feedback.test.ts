import { describe, expect, it } from "vitest";
import {
  checkFeedbackInput,
  downloadCountText,
  feedbackErrorMessage,
  feedbackPagePath,
  feedbackStatusFilter,
  isCleanFeedbackPath,
  FEEDBACK_ERRORS,
  parseAdminFeedbackRows,
  parseDownloadCount,
} from "./reader-feedback";

describe("download count (count b a, word b)", () => {
  it("shows nothing at 0 or for anything that is not a count", () => {
    for (const v of [0, -1, 1.5, NaN, null, undefined]) expect(downloadCountText(v as number)).toBeNull();
  });
  it("says shkarkim for 1 and shkarkime from 2, every number shown", () => {
    expect(downloadCountText(1)).toEqual({ number: "1", word: "shkarkim" });
    expect(downloadCountText(2)).toEqual({ number: "2", word: "shkarkime" });
    expect(downloadCountText(142)).toEqual({ number: "142", word: "shkarkime" });
  });
  it("groups thousands with a no-break space", () => {
    expect(downloadCountText(1234)?.number).toBe("1 234");
    expect(downloadCountText(1234567)?.number).toBe("1 234 567");
  });
  it("accepts only a non-negative integer from the database", () => {
    expect(parseDownloadCount(5)).toBe(5);
    expect(parseDownloadCount(0)).toBe(0);
    for (const v of ["5", -1, 2.5, null, undefined, {}]) expect(parseDownloadCount(v)).toBeNull();
  });
});

describe("feedback input (feedback c a)", () => {
  it("needs problem or idea", () => {
    expect(checkFeedbackInput("bug", "x", "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.kind });
    expect(checkFeedbackInput(undefined, "x", "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.kind });
  });
  it("needs text, trims it, and allows up to 1000 characters", () => {
    expect(checkFeedbackInput("idea", "   ", "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.empty });
    expect(checkFeedbackInput("idea", 5, "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.empty });
    expect(checkFeedbackInput("problem", "  Nuk punon.\n", "/libra/x")).toEqual({
      ok: true,
      kind: "problem",
      body: "Nuk punon.",
      pagePath: "/libra/x",
    });
    expect(checkFeedbackInput("idea", "a".repeat(1000), "/").ok).toBe(true);
    expect(checkFeedbackInput("idea", "a".repeat(1001), "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.long });
    // Counted like the database: one emoji is one character.
    expect(checkFeedbackInput("idea", "😀".repeat(1000), "/").ok).toBe(true);
  });
  it("keeps only a site path, without query or hash", () => {
    expect(feedbackPagePath("/libra/abc?x=1#top")).toBe("/libra/abc");
    expect(feedbackPagePath("/")).toBe("/");
    for (const v of ["https://evil.test/", "//evil.test", "/a\\b", "libra", "", null, 5, "/" + "a".repeat(300), "/a\nb"]) {
      expect(feedbackPagePath(v)).toBe("/");
    }
  });
  it("links only a clean stored path in the admin (audit r1 F1)", () => {
    expect(isCleanFeedbackPath("/libra/abc")).toBe(true);
    expect(isCleanFeedbackPath("/")).toBe(true);
    for (const v of ["/\\evil.example", "/\t/evil.example", "//evil.example", "/a?b=1", "/a\nb"]) {
      expect(isCleanFeedbackPath(v)).toBe(false);
    }
    expect(feedbackPagePath("/\\evil.example")).toBe("/");
    expect(feedbackPagePath("/\t/evil.example")).toBe("/");
  });
  it("treats a message of only no-break or zero-width spaces as empty (audit r1 F3)", () => {
    expect(checkFeedbackInput("idea", "\u00a0\u00a0", "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.empty });
    expect(checkFeedbackInput("idea", "\u200b\ufeff \u2060", "/")).toEqual({ ok: false, error: FEEDBACK_ERRORS.empty });
    expect(checkFeedbackInput("idea", "\u200bok\u200b", "/")).toMatchObject({ ok: true, body: "ok" });
  });
  it("turns the database refusals into words", () => {
    expect(feedbackErrorMessage("LB510")).toBe(FEEDBACK_ERRORS.suspended);
    expect(feedbackErrorMessage("LB511")).toBe(FEEDBACK_ERRORS.kind);
    expect(feedbackErrorMessage("LB512")).toBe(FEEDBACK_ERRORS.empty);
    expect(feedbackErrorMessage("LB514")).toBe(FEEDBACK_ERRORS.tooMany);
    expect(feedbackErrorMessage("LB513")).toBe(FEEDBACK_ERRORS.failed);
    expect(feedbackErrorMessage(undefined)).toBe(FEEDBACK_ERRORS.failed);
  });
});

describe("admin list (feedback d a)", () => {
  it("defaults to open", () => {
    expect(feedbackStatusFilter(undefined)).toBe("open");
    expect(feedbackStatusFilter("nope")).toBe("open");
    expect(feedbackStatusFilter("done")).toBe("done");
    expect(feedbackStatusFilter("all")).toBe("all");
  });
  it("keeps only rows of the exact shape", () => {
    const good = {
      id: "f1",
      kind: "problem",
      body: "x",
      page_path: "/",
      sender_email: "a@example.test",
      created_at: "2026-11-15T10:00:00Z",
      done_at: null,
    };
    expect(parseAdminFeedbackRows([good, { ...good, id: 1 }, { ...good, kind: "bug" }, { ...good, sender_email: 3 }, null])).toEqual([
      { id: "f1", kind: "problem", body: "x", pagePath: "/", senderEmail: "a@example.test", createdAt: "2026-11-15T10:00:00Z", doneAt: null },
    ]);
    expect(parseAdminFeedbackRows(null)).toEqual([]);
  });
});
