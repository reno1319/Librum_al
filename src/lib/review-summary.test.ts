import { describe, expect, it } from "vitest";
import {
  formatAverage,
  parseReviewsPage,
  parseStarFilter,
  reviewCountLabel,
  reviewFormStartsOpen,
  reviewerInitials,
  reviewsPageCount,
  reviewsPageHref,
  starLabel,
  summarizeReviews,
} from "./review-summary";

describe("summarizeReviews (item 15)", () => {
  it("rows 5 -> 1, each percent rounded on its own", () => {
    const s = summarizeReviews([5, 5, 5, 4, 1, 1]);
    expect(s.count).toBe(6);
    expect(formatAverage(s.average)).toBe("3,5");
    expect(s.buckets.map((b) => [b.stars, b.count, b.percent])).toEqual([
      [5, 3, 50], [4, 1, 17], [3, 0, 0], [2, 0, 0], [1, 2, 33],
    ]);
  });
  it("no reviews: zero everywhere, no division by zero", () => {
    const s = summarizeReviews([]);
    expect(s.count).toBe(0);
    expect(s.average).toBe(0);
    expect(s.buckets.every((b) => b.count === 0 && b.percent === 0)).toBe(true);
  });
});

describe("labels", () => {
  it("star and count words", () => {
    expect(starLabel(1)).toBe("1 yll");
    expect(starLabel(4)).toBe("4 yje");
    expect(reviewCountLabel(1)).toBe("1 vlerësim");
    expect(reviewCountLabel(128)).toBe("128 vlerësime");
  });
  it("initials from the review name; none = L", () => {
    expect(reviewerInitials("Elona Marku")).toBe("EM");
    expect(reviewerInitials("mira")).toBe("M");
    expect(reviewerInitials(null)).toBe("L");
    expect(reviewerInitials("  ")).toBe("L");
    expect(reviewerInitials("123")).toBe("L");
  });
});

describe("all-reviews page address (bp4 a)", () => {
  it("filter and page params", () => {
    expect(reviewsPageHref("b")).toBe("/libra/b/vleresimet");
    expect(reviewsPageHref("b", { stars: 5 })).toBe("/libra/b/vleresimet?yjet=5");
    expect(reviewsPageHref("b", { stars: 2, page: 3 })).toBe("/libra/b/vleresimet?yjet=2&faqja=3");
    expect(reviewsPageHref("b", { page: 1 })).toBe("/libra/b/vleresimet");
  });
  it("parses only 1..5 as a filter", () => {
    expect(parseStarFilter("3")).toBe(3);
    for (const bad of [undefined, "0", "6", "3.5", "x", ["3"], " 3"]) expect(parseStarFilter(bad)).toBeNull();
  });
  it("page: missing = 1, whole numbers from 1, anything else = null", () => {
    expect(parseReviewsPage(undefined)).toBe(1);
    expect(parseReviewsPage("2")).toBe(2);
    for (const bad of ["0", "-1", "1.5", "x", ["2"], "999999"]) expect(parseReviewsPage(bad)).toBeNull();
  });
  it("10 per page, at least one page", () => {
    expect(reviewsPageCount(0)).toBe(1);
    expect(reviewsPageCount(10)).toBe(1);
    expect(reviewsPageCount(11)).toBe(2);
  });
});

describe("reviewFormStartsOpen (rv1 a)", () => {
  const base = { rateStars: null, reviewStatus: undefined, error: null, ownStatus: null } as const;
  it("closed by default, also with an approved or pending review", () => {
    expect(reviewFormStartsOpen(base)).toBe(false);
    expect(reviewFormStartsOpen({ ...base, ownStatus: "approved" })).toBe(false);
    expect(reviewFormStartsOpen({ ...base, ownStatus: "pending" })).toBe(false);
    expect(reviewFormStartsOpen({ ...base, error: "Something else" })).toBe(false);
  });
  it("open from the reader's stars, after a save, on a review error, or when rejected", () => {
    expect(reviewFormStartsOpen({ ...base, rateStars: 4 })).toBe(true);
    expect(reviewFormStartsOpen({ ...base, reviewStatus: "pending" })).toBe(true);
    expect(reviewFormStartsOpen({ ...base, error: "Zgjidhni yjet." })).toBe(true);
    expect(reviewFormStartsOpen({ ...base, ownStatus: "rejected" })).toBe(true);
  });
});
