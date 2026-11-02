import { describe, expect, it } from "vitest";
import {
  REVIEW_APPROVED_MESSAGE,
  REVIEW_CHANGED_MESSAGE,
  REVIEW_CHOOSE_REASON_MESSAGE,
  REVIEW_NAME_CLEARED_MESSAGE,
  REVIEW_NAME_RULES_MESSAGE,
  REVIEW_NAME_SAVED_MESSAGE,
  REVIEW_NOTE_REQUIRED_MESSAGE,
  REVIEW_NOTE_TOO_LONG_MESSAGE,
  REVIEW_NOT_FOUND_MESSAGE,
  REVIEW_OWN_REVIEW_MESSAGE,
  REVIEW_REJECTED_MESSAGE,
  STAFF_GENERIC_ERROR_MESSAGE,
  accountAgeLabel,
  approveFailure,
  isSeenTimestamp,
  isUuid,
  rejectFailure,
  reviewCountLabel,
  setNameFailure,
  validateRejectForm,
  validateReviewName,
} from "./reader-review-logic";
import { PAGE_ERROR_MESSAGES, PAGE_SUCCESS_MESSAGES } from "@/lib/page-messages";

describe("reader review queue logic", () => {
  it("lists every message it redirects with", () => {
    for (const m of [REVIEW_APPROVED_MESSAGE, REVIEW_REJECTED_MESSAGE, REVIEW_NAME_SAVED_MESSAGE, REVIEW_NAME_CLEARED_MESSAGE]) {
      expect(PAGE_SUCCESS_MESSAGES.has(m)).toBe(true);
    }
    for (const m of [
      REVIEW_CHANGED_MESSAGE,
      REVIEW_NOT_FOUND_MESSAGE,
      REVIEW_OWN_REVIEW_MESSAGE,
      REVIEW_CHOOSE_REASON_MESSAGE,
      REVIEW_NOTE_REQUIRED_MESSAGE,
      REVIEW_NOTE_TOO_LONG_MESSAGE,
      REVIEW_NAME_RULES_MESSAGE,
      STAFF_GENERIC_ERROR_MESSAGE,
    ]) {
      expect(PAGE_ERROR_MESSAGES.has(m)).toBe(true);
    }
  });

  it("checks ids and the seen timestamp", () => {
    expect(isUuid("6f1c2c1e-1b2a-4c3d-8e9f-0a1b2c3d4e5f")).toBe(true);
    expect(isUuid("x")).toBe(false);
    expect(isSeenTimestamp("2026-11-02T10:00:00.123456+00:00")).toBe(true);
    expect(isSeenTimestamp("")).toBe(false);
    expect(isSeenTimestamp("nope")).toBe(false);
    expect(isSeenTimestamp(null)).toBe(false);
  });

  it("maps the approve and reject answers (null = it worked)", () => {
    expect(approveFailure("approved")).toBeNull();
    expect(approveFailure("changed")).toBe(REVIEW_CHANGED_MESSAGE);
    expect(approveFailure("not_found")).toBe(REVIEW_NOT_FOUND_MESSAGE);
    expect(approveFailure(null)).toBe(STAFF_GENERIC_ERROR_MESSAGE);
    expect(rejectFailure("rejected")).toBeNull();
    expect(rejectFailure("note_required")).toBe(REVIEW_NOTE_REQUIRED_MESSAGE);
    expect(rejectFailure("bad_reason")).toBe(REVIEW_CHOOSE_REASON_MESSAGE);
    expect(rejectFailure("note_too_long")).toBe(REVIEW_NOTE_TOO_LONG_MESSAGE);
    expect(rejectFailure("changed")).toBe(REVIEW_CHANGED_MESSAGE);
    expect(rejectFailure("approved")).toBe(STAFF_GENERIC_ERROR_MESSAGE);
    // Audit r1 S3: staff never decide their own review.
    expect(approveFailure("own_review")).toBe(REVIEW_OWN_REVIEW_MESSAGE);
    expect(rejectFailure("own_review")).toBe(REVIEW_OWN_REVIEW_MESSAGE);
  });

  it("checks the reject form (Q6a: a note is required only for Other)", () => {
    expect(validateRejectForm("", "")).toBe(REVIEW_CHOOSE_REASON_MESSAGE);
    expect(validateRejectForm("negative", "")).toBe(REVIEW_CHOOSE_REASON_MESSAGE);
    expect(validateRejectForm("other", "")).toBe(REVIEW_NOTE_REQUIRED_MESSAGE);
    expect(validateRejectForm("other", "Pse")).toBeNull();
    expect(validateRejectForm("abusive", "")).toBeNull();
    expect(validateRejectForm("abusive", "x".repeat(501))).toBe(REVIEW_NOTE_TOO_LONG_MESSAGE);
    expect(validateRejectForm("abusive", "x".repeat(500))).toBeNull();
  });

  it("checks a staff-typed review name; empty clears", () => {
    expect(validateReviewName("")).toBeNull();
    expect(validateReviewName("Ana")).toBeNull();
    expect(validateReviewName("A")).toBe(REVIEW_NAME_RULES_MESSAGE);
    expect(validateReviewName("x".repeat(41))).toBe(REVIEW_NAME_RULES_MESSAGE);
    expect(validateReviewName("An\na")).toBe(REVIEW_NAME_RULES_MESSAGE);
    expect(setNameFailure("saved")).toBeNull();
    expect(setNameFailure("bad_name")).toBe(REVIEW_NAME_RULES_MESSAGE);
    expect(setNameFailure("not_found")).toBe(STAFF_GENERIC_ERROR_MESSAGE);
  });

  it("labels the fake-review signals", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    expect(accountAgeLabel("2026-11-02T01:00:00Z", now)).toBe("created today");
    expect(accountAgeLabel("2026-11-01T11:00:00Z", now)).toBe("1 day old");
    expect(accountAgeLabel("2026-10-21T12:00:00Z", now)).toBe("12 days old");
    expect(accountAgeLabel(null, now)).toBe("age unknown");
    expect(reviewCountLabel(1, 0)).toBe("1 review in all, 0 approved");
    expect(reviewCountLabel(3, 2)).toBe("3 reviews in all, 2 approved");
  });
});
