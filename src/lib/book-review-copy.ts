// ADMIN-3-REVIEW: the shared words and the author-side column list of
// "In review" (public.book_reviews, migration 20261020120000). Pure and
// client-safe: the Dashboard row, the Edit page, the actions and the
// admin pages all read from here, so one sentence never drifts.
import { SUPPORT_EMAIL, takedownReasonLabel } from "@/lib/takedown-reasons";

// R1 (ADMIN-2 style): authenticated holds SELECT on these columns of
// book_reviews and no others (no id, no paths, no checklist, no
// decided_by), so `select *` fails with 42501 for an author session.
// Every author-session read names exactly this list.
export const AUTHOR_REVIEW_COLUMNS =
  "book_id, book_title, author_id, status, submitted_at, reason, message_to_author, decided_at";

export const BOOK_REVIEW_STATUSES = ["pending", "approved", "sent_back", "withdrawn", "cancelled"] as const;
export type BookReviewStatus = (typeof BOOK_REVIEW_STATUSES)[number];

export type AuthorReviewRow = {
  book_id: string | null;
  book_title: string;
  author_id: string | null;
  status: BookReviewStatus;
  submitted_at: string;
  reason: string | null;
  message_to_author: string | null;
  decided_at: string | null;
};

/** A send back as the author sees it (only while it is the newest review). */
export type AuthorSentBackNotice = {
  sentBackAt: string;
  reason: string;
  message: string;
};

/** What the Dashboard row and the Edit page show for one book. */
export type AuthorReviewNotice = {
  inReview: boolean;
  sentBack: AuthorSentBackNotice | null;
};

// "Newest" is the same order book_review_state() uses: the latest
// submission first; among rows submitted together, an undecided
// (pending) row before decided ones, then the latest decision.
function newestFirst(a: AuthorReviewRow, b: AuthorReviewRow): number {
  const submitted = Date.parse(b.submitted_at) - Date.parse(a.submitted_at);
  if (submitted !== 0) return submitted;
  const decided = (row: AuthorReviewRow) => (row.decided_at === null ? Infinity : Date.parse(row.decided_at));
  return decided(b) - decided(a);
}

/**
 * Per book: "In review" while a review is pending; the send-back notice
 * only when the NEWEST review row is a send back (P4).
 */
export function buildAuthorReviewNotices(rows: readonly AuthorReviewRow[]): Map<string, AuthorReviewNotice> {
  const byBook = new Map<string, AuthorReviewRow[]>();
  for (const row of rows) {
    if (row.book_id === null) continue;
    const list = byBook.get(row.book_id) ?? [];
    list.push(row);
    byBook.set(row.book_id, list);
  }
  const notices = new Map<string, AuthorReviewNotice>();
  for (const [bookId, list] of byBook) {
    const newest = [...list].sort(newestFirst)[0];
    const inReview = list.some((row) => row.status === "pending");
    const sentBack =
      newest.status === "sent_back" && newest.reason && newest.message_to_author && newest.decided_at
        ? { sentBackAt: newest.decided_at, reason: newest.reason, message: newest.message_to_author }
        : null;
    if (inReview || sentBack) notices.set(bookId, { inReview, sentBack });
  }
  return notices;
}

function withFinalStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export const QUESTIONS_LINE = `Questions? Write to ${SUPPORT_EMAIL}`;

/**
 * F: "Librum sent this book back on <date>. Reason: <label>. <message>
 * Fix it and send it for review again. Questions? Write to
 * support@librum.al", as separate lines in reading order.
 */
export function buildAuthorSentBackNoticeLines(
  notice: AuthorSentBackNotice,
  formatDate: (iso: string) => string,
): string[] {
  return [
    `Librum sent this book back on ${formatDate(notice.sentBackAt)}. Reason: ${takedownReasonLabel(notice.reason)}.`,
    withFinalStop(notice.message),
    "Fix it and send it for review again.",
    QUESTIONS_LINE,
  ];
}

export const IN_REVIEW_LABEL = "In review";

// B: the publish control's label. "Send for review" for a draft without
// a valid approval; "Publish" once Librum has approved its current
// files (3a: a republish with nothing new goes live straight away).
export const SEND_FOR_REVIEW_LABEL = "Send for review";
export const PUBLISH_APPROVED_LABEL = "Publish";

export function publishControlLabel(approvalValid: boolean): string {
  return approvalValid ? PUBLISH_APPROVED_LABEL : SEND_FOR_REVIEW_LABEL;
}

// A: performPublish's review outcomes.
export const SENT_FOR_REVIEW_MESSAGE =
  "Sent for review. We'll check your book and tell you when it's live. It isn't in the Bookstore yet.";
export const ALREADY_IN_REVIEW_MESSAGE = "This book is already waiting for review.";

// E: Cancel review.
export const CANCEL_REVIEW_LABEL = "Cancel review";
export const REVIEW_CANCELLED_MESSAGE = "Review cancelled. Your book is a draft again.";
export const NOT_IN_REVIEW_MESSAGE = "This book isn't waiting for review.";

// C / S5: a new file or cover on a live book.
export const LIVE_FILES_WARNING =
  "Changing the book file or cover takes your book out of the Bookstore until Librum approves it. Other changes go live at once.";
export const LIVE_FILES_SAVED_MESSAGE =
  "Saved. Your book is out of the Bookstore until Librum approves the new file or cover.";
export const LIVE_FILES_REQUEST_FAILED_MESSAGE = "Saved. Press Send for review when you're ready.";
export const LIVE_FILES_IN_BUNDLE_MESSAGE =
  "This book is part of a published bundle. Unpublish the bundle first, then change the file or cover.";

// S3: LB462 / LB463 caught at the write (the book changed after it was
// read).
export const BOOK_CHANGED_WHILE_EDITING_MESSAGE = "Your book changed while you were editing. Reload and try again.";

// H: the staff side.
export const REVIEW_CHECKLIST_ITEMS = [
  { key: "cover_is_fine", label: "The cover is fine" },
  { key: "file_opens", label: "The book file opens" },
  { key: "not_someone_elses_work", label: "It isn't someone else's work" },
  { key: "rights_declared", label: "The author declared their rights" },
] as const;
export type ReviewChecklistKey = (typeof REVIEW_CHECKLIST_ITEMS)[number]["key"];

// Staff review history (R5/U1): the migration's grandfathered rows.
// buyer_file_only rows (A1: a draft readers may already hold) are the
// readers' copy, never a publishable approval.
export const GRANDFATHERED_HISTORY_LABEL = "Live before reviews began";
export const BUYER_FILE_ONLY_HISTORY_LABEL = "Readers' copy from before reviews began (needs review to go live)";

export const REVIEW_STATUS_LABELS: Record<BookReviewStatus, string> = {
  pending: "Waiting",
  approved: "Approved",
  sent_back: "Sent back",
  withdrawn: "Cancelled by the author",
  cancelled: "Replaced or closed",
};
