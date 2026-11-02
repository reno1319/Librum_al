// BD13: reader reviews -- the public display name, staff approval and
// the verified-purchase badge (migration 20261102120000). Renato's
// answers 2026-11-01 (1b 2b 3a 4a 5a) and 2026-11-02 (Q1a Q2a Q3a Q4a
// Q5b Q6a Q7a). Pure copy and mapping, shared by the book page, its
// server action and the admin queue, so each is testable without a
// render.

import { SUPPORT_EMAIL } from "@/lib/contact";

/** The rejection reasons (Q6a). "Negative" is deliberately not one. */
export const REVIEW_REJECTION_REASONS = [
  "abusive",
  "personal_data",
  "off_topic",
  "advertising",
  "bad_name",
  "other",
] as const;

export type ReviewRejectionReason = (typeof REVIEW_REJECTION_REASONS)[number];

export function isReviewRejectionReason(value: unknown): value is ReviewRejectionReason {
  return typeof value === "string" && (REVIEW_REJECTION_REASONS as readonly string[]).includes(value);
}

/** What the reader sees on the book page (Albanian). */
export const REVIEW_REJECTION_LABELS_SQ: Record<ReviewRejectionReason, string> = {
  abusive: "Fjalë fyese ose vulgare",
  personal_data: "Të dhëna personale",
  off_topic: "Nuk flet për librin",
  advertising: "Reklamë ose lidhje",
  bad_name: "Emri i papërshtatshëm",
  other: "Tjetër",
};

/** What staff pick from in the admin queue (the admin is in English). */
export const REVIEW_REJECTION_LABELS_EN: Record<ReviewRejectionReason, string> = {
  abusive: "Abusive or vulgar words",
  personal_data: "Personal data",
  off_topic: "Not about the book",
  advertising: "Advertising or links",
  bad_name: "Unsuitable name (the reader must choose a new one)",
  other: "Other (note required)",
};

export const REVIEW_NAME_MIN = 2;
export const REVIEW_NAME_MAX = 40;
export const REVIEW_BODY_MAX = 4000;
export const REVIEW_NOTE_MAX = 500;

/** The page's fallback when a review has no name (kept from before BD13). */
export const ANONYMOUS_REVIEWER_NAME = "Një lexues i Librum";

export const VERIFIED_PURCHASE_LABEL = "Blerje e verifikuar";

/**
 * The neutral tag on a review whose account was an author account when
 * staff approved it (Renato's a, 2026-11-02; frozen at approval after
 * audit r3): readers can tell an author reviewing a rival's book,
 * without learning which pen name.
 */
export const AUTHOR_REVIEWER_LABEL = "Autor në Librum";

// Messages for submit_reader_review()'s refusals. Each one is also on
// PAGE_ERROR_MESSAGES (page-messages.ts), so the page shows it.
export const REVIEW_NOT_OWNER_MESSAGE = "Blini këtë libër për ta vlerësuar.";
export const REVIEW_OWN_BOOK_MESSAGE = "Nuk mund ta vlerësoni librin tuaj.";
export const REVIEW_BAD_RATING_MESSAGE = "Zgjidhni yjet.";
export const REVIEW_TOO_LONG_MESSAGE = "Komenti mund të ketë deri në 4.000 karaktere.";
export const REVIEW_NAME_REQUIRED_MESSAGE = "Shkruani emrin që do të shfaqet te vlerësimi.";
export const REVIEW_BAD_NAME_MESSAGE = "Emri duhet të ketë nga 2 deri në 40 karaktere.";
export const REVIEW_SAVE_FAILED_MESSAGE = "Nuk e ruajtëm dot vlerësimin tuaj. Provoni përsëri.";

export type SubmitReviewOutcome =
  | { kind: "status"; status: "pending" | "unchanged" }
  | { kind: "error"; message: string };

/** submit_reader_review()'s one-word result to what the page shows. */
export function submitReviewOutcome(result: unknown): SubmitReviewOutcome {
  switch (result) {
    case "pending":
      return { kind: "status", status: "pending" };
    case "unchanged":
      return { kind: "status", status: "unchanged" };
    case "not_owner":
      return { kind: "error", message: REVIEW_NOT_OWNER_MESSAGE };
    case "own_book":
      return { kind: "error", message: REVIEW_OWN_BOOK_MESSAGE };
    case "bad_rating":
      return { kind: "error", message: REVIEW_BAD_RATING_MESSAGE };
    case "too_long":
      return { kind: "error", message: REVIEW_TOO_LONG_MESSAGE };
    case "name_required":
      return { kind: "error", message: REVIEW_NAME_REQUIRED_MESSAGE };
    case "bad_name":
      return { kind: "error", message: REVIEW_BAD_NAME_MESSAGE };
    default:
      return { kind: "error", message: REVIEW_SAVE_FAILED_MESSAGE };
  }
}

// The green box after a save (?review=pending / ?review=unchanged).
export const REVIEW_PENDING_NOTICE =
  "Faleminderit! Vlerësimi juaj po shqyrtohet dhe do të shfaqet pasi ta miratojë stafi.";
export const REVIEW_UNCHANGED_NOTICE = "Vlerësimi juaj nuk ndryshoi.";

/**
 * The published rule (3a), under the review form. It names exactly the
 * fixed reason list (Q6a, REVIEW_REJECTION_LABELS_SQ), "Tjetër"
 * included, so it promises no more than staff can do (audit r1 S2).
 */
export const REVIEW_RULES_NOTE =
  "Çdo vlerësim kontrollohet nga stafi para se të shfaqet. Një vlerësim refuzohet vetëm për njërën nga këto arsye: fjalë fyese ose vulgare, të dhëna personale, tekst që nuk flet për librin, reklamë ose lidhje, emri i papërshtatshëm, ose një arsye tjetër që stafi e shpjegon me shënim. Një vlerësim nuk refuzohet kurrë sepse është negativ. Arsyen e shihni këtu, mbi formularin.";

export const REVIEW_NAME_HELP = `Shfaqet publikisht te vlerësimet tuaja. Mund të jetë emri juaj ose një pseudonim. Më vonë mund ta ndryshojë vetëm stafi: shkruani te ${SUPPORT_EMAIL}.`;

export const REVIEW_EDIT_WARNING =
  "Nëse e ndryshoni, vlerësimi hiqet nga faqja derisa stafi ta miratojë përsëri.";

export type OwnReviewStatus = "pending" | "approved" | "rejected";

export type OwnReview = {
  id: string;
  rating: number;
  body: string | null;
  status: OwnReviewStatus;
  rejection_reason: string | null;
  rejection_note: string | null;
};

/** The box above the reader's own review form, or null for none. */
export function ownReviewNotice(review: OwnReview | null): { tone: "info" | "warning"; lines: string[] } | null {
  if (!review) return null;
  if (review.status === "pending") {
    return {
      tone: "info",
      lines: ["Vlerësimi juaj po shqyrtohet. Do të shfaqet pasi ta miratojë stafi."],
    };
  }
  if (review.status === "rejected") {
    const label = isReviewRejectionReason(review.rejection_reason)
      ? REVIEW_REJECTION_LABELS_SQ[review.rejection_reason]
      : REVIEW_REJECTION_LABELS_SQ.other;
    const lines = [`Vlerësimi juaj nuk u miratua: ${label}.`];
    if (review.rejection_note) lines.push(`Shënim nga stafi: ${review.rejection_note}`);
    lines.push(
      review.rejection_reason === "bad_name"
        ? "Zgjidhni një emër tjetër dhe dërgojeni përsëri."
        : "Ndryshojeni dhe dërgojeni përsëri.",
    );
    return { tone: "warning", lines };
  }
  return null;
}
