// BD13: the admin queue's pure helpers -- what each staff database
// function's one-word answer means on the page, and the form checks
// done before calling it. The database functions check everything
// again; these only give staff a clear message.

import { isReviewRejectionReason, REVIEW_NAME_MAX, REVIEW_NAME_MIN, REVIEW_NOTE_MAX } from "@/lib/reader-reviews";

export const READER_REVIEWS_PATH = "/admin/reader-reviews";

export const REVIEW_APPROVED_MESSAGE = "Review approved.";
export const REVIEW_REJECTED_MESSAGE = "Review rejected. The reader sees the reason on the book page.";
export const REVIEW_CHANGED_MESSAGE = "The reader changed this review after you opened it, or it was already decided. Read it again.";
export const REVIEW_NOT_FOUND_MESSAGE = "That review no longer exists.";
export const REVIEW_OWN_REVIEW_MESSAGE = "You can't approve or reject your own review. Another staff member has to.";
export const REVIEW_CHOOSE_REASON_MESSAGE = "Choose a reason.";
export const REVIEW_NOTE_REQUIRED_MESSAGE = "Write a note for “Other”.";
export const REVIEW_NOTE_TOO_LONG_MESSAGE = "The note can have at most 500 characters.";
export const REVIEW_NAME_SAVED_MESSAGE = "Review name saved.";
export const REVIEW_NAME_CLEARED_MESSAGE = "Review name cleared. The reader chooses a new one on their next review.";
export const REVIEW_NAME_RULES_MESSAGE = "A review name has 2 to 40 characters.";
export const STAFF_GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

/** The updated_at the staff member saw, as the page rendered it. */
export function isSeenTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

// Each staff function's answer: null when it worked, else the message
// to show. The success message is the action's own constant.
export function approveFailure(result: unknown): string | null {
  if (result === "approved") return null;
  if (result === "changed") return REVIEW_CHANGED_MESSAGE;
  if (result === "own_review") return REVIEW_OWN_REVIEW_MESSAGE;
  if (result === "not_found") return REVIEW_NOT_FOUND_MESSAGE;
  return STAFF_GENERIC_ERROR_MESSAGE;
}

export function rejectFailure(result: unknown): string | null {
  if (result === "rejected") return null;
  if (result === "changed") return REVIEW_CHANGED_MESSAGE;
  if (result === "own_review") return REVIEW_OWN_REVIEW_MESSAGE;
  if (result === "not_found") return REVIEW_NOT_FOUND_MESSAGE;
  if (result === "bad_reason") return REVIEW_CHOOSE_REASON_MESSAGE;
  if (result === "note_required") return REVIEW_NOTE_REQUIRED_MESSAGE;
  if (result === "note_too_long") return REVIEW_NOTE_TOO_LONG_MESSAGE;
  return STAFF_GENERIC_ERROR_MESSAGE;
}

/** The reject form, checked before the call. Null = fine. */
export function validateRejectForm(reason: unknown, note: string): string | null {
  if (!isReviewRejectionReason(reason)) return REVIEW_CHOOSE_REASON_MESSAGE;
  if (reason === "other" && note === "") return REVIEW_NOTE_REQUIRED_MESSAGE;
  if (note.length > REVIEW_NOTE_MAX) return REVIEW_NOTE_TOO_LONG_MESSAGE;
  return null;
}

/** The people page's name form, checked before the call. Null = fine; "" clears. */
export function validateReviewName(name: string): string | null {
  if (name === "") return null;
  const hasControl = Array.from(name).some((ch) => {
    const code = ch.charCodeAt(0);
    return code < 32 || code === 127;
  });
  if (name.length < REVIEW_NAME_MIN || name.length > REVIEW_NAME_MAX || hasControl) {
    return REVIEW_NAME_RULES_MESSAGE;
  }
  return null;
}

export function setNameFailure(result: unknown): string | null {
  if (result === "saved") return null;
  if (result === "bad_name") return REVIEW_NAME_RULES_MESSAGE;
  return STAFF_GENERIC_ERROR_MESSAGE;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "created today" / "1 day old" / "12 days old" -- a fake-review signal (5a). */
export function accountAgeLabel(createdAt: string | null, now: Date): string {
  const created = createdAt ? Date.parse(createdAt) : Number.NaN;
  if (Number.isNaN(created)) return "age unknown";
  const days = Math.max(0, Math.floor((now.getTime() - created) / DAY_MS));
  if (days === 0) return "created today";
  return days === 1 ? "1 day old" : `${days} days old`;
}

/** The reviewer's own review count, this one included. */
export function reviewCountLabel(total: number, approved: number): string {
  const reviews = total === 1 ? "1 review" : `${total} reviews`;
  return `${reviews} in all, ${approved} approved`;
}
