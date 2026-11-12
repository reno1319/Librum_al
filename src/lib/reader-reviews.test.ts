import { describe, expect, it } from "vitest";
import {
  AUTHOR_REVIEWER_LABEL,
  VERIFIED_PURCHASE_LABEL,
  REVIEW_REJECTION_LABELS_EN,
  REVIEW_REJECTION_LABELS_SQ,
  REVIEW_REJECTION_REASONS,
  REVIEW_RULES_NOTE,
  isReviewRejectionReason,
  ownReviewNotice,
  REVIEW_UNCHANGED_NOTICE,
  savedReviewNotice,
  submitReviewOutcome,
  type OwnReview,
} from "./reader-reviews";
import { PAGE_ERROR_MESSAGES } from "./page-messages";

// BD13: the book page's review copy and mapping.
const base: OwnReview = {
  id: "r1",
  rating: 4,
  body: "Mirë",
  status: "approved",
  rejection_reason: null,
  rejection_note: null,
};

describe("submitReviewOutcome", () => {
  it("maps the two successes to a status", () => {
    expect(submitReviewOutcome("pending")).toEqual({ kind: "status", status: "pending" });
    expect(submitReviewOutcome("unchanged")).toEqual({ kind: "status", status: "unchanged" });
  });

  it.each(["not_owner", "own_book", "bad_rating", "too_long", "name_required", "bad_name", "???", null])(
    "maps %s to an error the page is allowed to show",
    (result) => {
      const outcome = submitReviewOutcome(result);
      expect(outcome.kind).toBe("error");
      if (outcome.kind === "error") expect(PAGE_ERROR_MESSAGES.has(outcome.message)).toBe(true);
    },
  );
});

describe("rejection reasons", () => {
  it("has a label in both languages for every reason, and none for negativity", () => {
    for (const reason of REVIEW_REJECTION_REASONS) {
      expect(REVIEW_REJECTION_LABELS_SQ[reason]).toBeTruthy();
      expect(REVIEW_REJECTION_LABELS_EN[reason]).toBeTruthy();
    }
    expect(REVIEW_REJECTION_REASONS.join(" ")).not.toMatch(/negative/);
  });

  it("the published rule names exactly the reason list, and promises a negative review is never refused (audit r1 S2)", () => {
    const note = REVIEW_RULES_NOTE.toLowerCase();
    for (const reason of REVIEW_REJECTION_REASONS) {
      expect(note).toContain(REVIEW_REJECTION_LABELS_SQ[reason].toLowerCase());
    }
    expect(note).toContain("vetëm për njërën nga këto arsye");
    expect(note).toContain("nuk refuzohet kurrë sepse është negativ");
  });

  it("recognises only the listed reasons", () => {
    expect(isReviewRejectionReason("abusive")).toBe(true);
    expect(isReviewRejectionReason("negative")).toBe(false);
    expect(isReviewRejectionReason(undefined)).toBe(false);
  });
});

describe("review tags", () => {
  it("are neutral words, never a name", () => {
    expect(VERIFIED_PURCHASE_LABEL).toBe("Blerje e verifikuar");
    expect(AUTHOR_REVIEWER_LABEL).toBe("Autor në Librum");
  });
});

describe("ownReviewNotice", () => {
  it("shows nothing without a review or for an approved one", () => {
    expect(ownReviewNotice(null)).toBeNull();
    expect(ownReviewNotice(base)).toBeNull();
  });

  it("says a pending review is waiting for staff", () => {
    expect(ownReviewNotice({ ...base, status: "pending" })).toEqual({
      tone: "info",
      lines: ["Vlerësimi juaj po shqyrtohet. Do të shfaqet pasi ta miratojë stafi."],
    });
  });

  it("gives the reason and the note of a rejection (Q4a)", () => {
    expect(
      ownReviewNotice({ ...base, status: "rejected", rejection_reason: "other", rejection_note: "Hiqni lidhjen." }),
    ).toEqual({
      tone: "warning",
      lines: ["Vlerësimi juaj nuk u miratua: Tjetër.", "Shënim nga stafi: Hiqni lidhjen.", "Ndryshojeni dhe dërgojeni përsëri."],
    });
  });

  it("asks for a new name after a bad-name rejection", () => {
    const notice = ownReviewNotice({ ...base, status: "rejected", rejection_reason: "bad_name" });
    expect(notice?.lines).toEqual([
      "Vlerësimi juaj nuk u miratua: Emri i papërshtatshëm.",
      "Zgjidhni një emër tjetër dhe dërgojeni përsëri.",
    ]);
  });
});

describe("savedReviewNotice (BD13a: no second or stale 'po shqyrtohet')", () => {
  it("shows no green box for a saved review (the box above the form says it)", () => {
    expect(savedReviewNotice("pending")).toBeNull();
  });

  it("keeps the unchanged box, and shows nothing for other values", () => {
    expect(savedReviewNotice("unchanged")).toBe(REVIEW_UNCHANGED_NOTICE);
    expect(savedReviewNotice(undefined)).toBeNull();
    expect(savedReviewNotice("approved")).toBeNull();
  });
});
