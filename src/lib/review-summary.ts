// Amazon book page, patch 3 (items 15, 18, 19, 21, 25, 26; design r7,
// plan r2 bp3 a + bp4 a). Pure helpers for the reviews block, the star
// pop-up and the all-reviews page (/libra/<id>/vleresimet), so each rule
// is testable without a render. No database change: everything here is
// worked out from the approved reviews public_reviews already returns.

import { getAuthorInitials } from "@/lib/author-initials";
import {
  REVIEW_BAD_NAME_MESSAGE,
  REVIEW_BAD_RATING_MESSAGE,
  REVIEW_NAME_REQUIRED_MESSAGE,
  REVIEW_NOT_OWNER_MESSAGE,
  REVIEW_OWN_BOOK_MESSAGE,
  REVIEW_SAVE_FAILED_MESSAGE,
  REVIEW_TOO_LONG_MESSAGE,
} from "@/lib/reader-reviews";

/** Item 19: the book page shows the newest 3, then "Shiko të gjitha". */
export const BOOK_PAGE_REVIEW_COUNT = 3;
/** bp4 a: the all-reviews page shows 10 per page. */
export const REVIEWS_PER_PAGE = 10;

export type StarBucket = { stars: 1 | 2 | 3 | 4 | 5; count: number; percent: number };
export type ReviewSummary = { count: number; average: number; buckets: StarBucket[] };

const STAR_VALUES = [5, 4, 3, 2, 1] as const;

/**
 * Item 15: the 5 -> 1 rows. Each percent is rounded on its own, like
 * Amazon's, so the five may add up to 99 or 101. A rating outside 1..5
 * (never stored: the database refuses it) is left out of the rows but
 * still counts in the total and average, the same figures the rating
 * line under the title already shows.
 */
export function summarizeReviews(ratings: readonly number[]): ReviewSummary {
  const count = ratings.length;
  const average = count > 0 ? ratings.reduce((sum, r) => sum + r, 0) / count : 0;
  const buckets = STAR_VALUES.map((stars) => {
    const n = ratings.filter((r) => r === stars).length;
    return { stars, count: n, percent: count > 0 ? Math.round((n / count) * 100) : 0 };
  });
  return { count, average, buckets };
}

/** "4,6": one decimal with a comma, as the rating line shows it. */
export function formatAverage(average: number): string {
  return average.toFixed(1).replace(".", ",");
}

/** "5 yje" ... "1 yll". */
export function starLabel(stars: number): string {
  return stars === 1 ? "1 yll" : `${stars} yje`;
}

/** "1 vlerësim" / "128 vlerësime". */
export function reviewCountLabel(count: number): string {
  return `${count} ${count === 1 ? "vlerësim" : "vlerësime"}`;
}

/** ?yjet=N on the all-reviews page: 1..5, anything else = no filter. */
export function parseStarFilter(raw: string | string[] | undefined): 1 | 2 | 3 | 4 | 5 | null {
  if (typeof raw !== "string" || !/^[1-5]$/.test(raw)) return null;
  return Number(raw) as 1 | 2 | 3 | 4 | 5;
}

/** ?faqja=N: a whole number from 1; anything else = null (page answers not found). */
export function parseReviewsPage(raw: string | string[] | undefined): number | null {
  if (raw === undefined) return 1;
  if (typeof raw !== "string" || !/^[1-9][0-9]{0,4}$/.test(raw)) return null;
  return Number(raw);
}

export function reviewsPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / REVIEWS_PER_PAGE));
}

/** The address of the all-reviews page, with an optional star filter and page. */
export function reviewsPageHref(bookId: string, opts: { stars?: number | null; page?: number } = {}): string {
  const params = new URLSearchParams();
  if (opts.stars) params.set("yjet", String(opts.stars));
  if (opts.page && opts.page > 1) params.set("faqja", String(opts.page));
  const query = params.toString();
  return `/libra/${bookId}/vleresimet${query ? `?${query}` : ""}`;
}

/**
 * Item 18: the letters in the reviewer's circle, from the public review
 * name. A review with no name shows "Një lexues i Librum"; its circle
 * says "L" (lexues), not "NL".
 */
export function reviewerInitials(name: string | null): string {
  const trimmed = name?.trim() ?? "";
  if (!trimmed) return "L";
  return getAuthorInitials(trimmed) || "L";
}

/** Item 25: "Si funksionojnë vlerësimet", true to how the site works today. */
export const HOW_REVIEWS_WORK_LINES = [
  "Vlerësimet i shkruajnë lexuesit që e kanë librin në Bibliotekën e tyre. Autori nuk mund ta vlerësojë librin e vet.",
  "Çdo vlerësim kontrollohet nga stafi para se të shfaqet. Një vlerësim nuk refuzohet kurrë sepse është negativ.",
  "Nota është mesatarja e yjeve të të gjitha vlerësimeve që shfaqen.",
  "«Blerje e verifikuar» do të thotë që lexuesi e pagoi librin dhe nuk i kërkoi paratë mbrapsht.",
  "«Autor në Librum» do të thotë që vlerësimin e shkroi dikush që boton libra në Librum.",
] as const;

/** bp3 a: what a reader without the book sees under the button. */
export const REVIEW_OWNERS_ONLY_NOTE = "Vlerësimet i shkruajnë lexuesit që e kanë librin.";

const REVIEW_SAVE_ERRORS: ReadonlySet<string> = new Set([
  REVIEW_NOT_OWNER_MESSAGE,
  REVIEW_OWN_BOOK_MESSAGE,
  REVIEW_BAD_RATING_MESSAGE,
  REVIEW_TOO_LONG_MESSAGE,
  REVIEW_NAME_REQUIRED_MESSAGE,
  REVIEW_BAD_NAME_MESSAGE,
  REVIEW_SAVE_FAILED_MESSAGE,
]);

/**
 * rv1 a: the owner's review form sits behind "Shkruani një vlerësim",
 * but is already open when the reader is clearly in the middle of a
 * review: they came from the stars in the reader (?yje=N), just saved
 * (?review=...), the save failed (one of the review errors), or staff
 * sent the review back (rejected).
 */
export function reviewFormStartsOpen(input: {
  rateStars: number | null;
  reviewStatus: string | undefined;
  error: string | null;
  ownStatus: "pending" | "approved" | "rejected" | null;
}): boolean {
  return (
    input.rateStars !== null ||
    !!input.reviewStatus ||
    (input.error !== null && REVIEW_SAVE_ERRORS.has(input.error)) ||
    input.ownStatus === "rejected"
  );
}
