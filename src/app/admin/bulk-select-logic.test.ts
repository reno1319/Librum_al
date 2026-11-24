import { describe, expect, it } from "vitest";
import {
  BULK_MAX,
  emptyReviewBulkCounts,
  encodeFeedbackBulk,
  encodeReviewBulk,
  feedbackBulkLines,
  parseFeedbackBulk,
  parseFeedbackPicks,
  parseReviewBulk,
  parseReviewPicks,
  reviewBulkLines,
  tallyReviewResult,
} from "./bulk-select-logic";

// G4 batch 3 (g4q11 a, b3e1 a): the bulk actions' pure parts.
const R1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const R2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const BOOK = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SEEN = "2026-11-02T10:00:00.123456+00:00";

describe("parseReviewPicks", () => {
  it("reads id|seen|book, dropping a repeated review", () => {
    expect(parseReviewPicks([`${R1}|${SEEN}|${BOOK}`, `${R2}|${SEEN}|${BOOK}`, `${R1}|${SEEN}|${BOOK}`])).toEqual([
      { reviewId: R1, seen: SEEN, bookId: BOOK },
      { reviewId: R2, seen: SEEN, bookId: BOOK },
    ]);
  });

  it("refuses an empty, oversized or malformed form", () => {
    expect(parseReviewPicks([])).toBeNull();
    expect(parseReviewPicks(Array.from({ length: BULK_MAX + 1 }, () => `${R1}|${SEEN}|${BOOK}`))).toBeNull();
    for (const bad of [`${R1}|${SEEN}`, `x|${SEEN}|${BOOK}`, `${R1}|not-a-date|${BOOK}`, `${R1}|${SEEN}|x`, 7]) {
      expect(parseReviewPicks([bad])).toBeNull();
    }
  });
});

describe("parseFeedbackPicks", () => {
  it("reads unique ids and refuses anything else", () => {
    expect(parseFeedbackPicks([R1, R2, R1])).toEqual([R1, R2]);
    expect(parseFeedbackPicks([])).toBeNull();
    expect(parseFeedbackPicks([R1, "x"])).toBeNull();
  });
});

describe("tally, encode and parse", () => {
  it("counts each database answer and round-trips as digits", () => {
    const c = emptyReviewBulkCounts();
    for (const r of ["approved", "approved", "changed", "own_review", "not_found", "weird"]) tallyReviewResult(c, r, false);
    tallyReviewResult(c, "approved", true);
    expect(c).toEqual({ approved: 2, changed: 1, own: 1, gone: 1, failed: 2 });
    expect(encodeReviewBulk(c)).toBe("2.1.1.1.2");
    expect(parseReviewBulk("2.1.1.1.2")).toEqual(c);
    expect(parseFeedbackBulk(encodeFeedbackBulk({ done: 3, gone: 0, failed: 1 }))).toEqual({ done: 3, gone: 0, failed: 1 });
  });

  it("ignores anything that is not exactly digits", () => {
    for (const bad of [undefined, "", "1.2", "1.2.3.4.x", "1.2.3.4.5.6", "<b>1</b>", "999.999.0.0.0"]) {
      expect(parseReviewBulk(bad)).toBeNull();
    }
    expect(parseFeedbackBulk("1.2")).toBeNull();
  });
});

describe("the lines (b3e1 a)", () => {
  it("says how many worked and why the others did not", () => {
    expect(reviewBulkLines({ approved: 4, changed: 1, own: 0, gone: 0, failed: 0 })).toEqual({
      success: "4 reviews approved.",
      error:
        "1 not approved: the reader changed it after you opened the page, or it was already decided. Read it again; it stays in the list.",
    });
    expect(reviewBulkLines({ approved: 1, changed: 0, own: 0, gone: 2, failed: 0 })).toEqual({
      success: "1 review approved.",
      error: "2 not approved: the review no longer exists.",
    });
    expect(reviewBulkLines({ approved: 0, changed: 0, own: 0, gone: 0, failed: 2 }).success).toBeNull();
    expect(feedbackBulkLines({ done: 1, gone: 0, failed: 0 })).toEqual({ success: "1 message marked done.", error: null });
    expect(feedbackBulkLines({ done: 0, gone: 1, failed: 2 }).error).toBe(
      "1 not marked done: the message no longer exists. 2 not marked done: something went wrong. They stay in Open; try again.",
    );
  });
});
