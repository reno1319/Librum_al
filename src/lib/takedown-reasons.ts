// ADMIN-2-TAKEDOWN: the shared words of an admin takedown (Unpublish),
// for the staff pages, the author's notice, the publish/delete refusals
// and the email. Pure and client-safe.
//
// The five reasons (Renato's 7a, exact labels). The codes are what
// public.book_takedowns.reason stores; admin_unpublish_book() writes the
// label into the resolved report's admin_notes through its own CASE,
// which takedown-reasons.test.ts checks against this map.
export const TAKEDOWN_REASONS = ["copyright", "content_rules", "broken_file", "author_asked", "other"] as const;

export type TakedownReason = (typeof TAKEDOWN_REASONS)[number];

export const TAKEDOWN_REASON_LABELS: Record<TakedownReason, string> = {
  copyright: "Copyright complaint",
  content_rules: "Breaks content rules",
  broken_file: "Wrong or broken file",
  author_asked: "Author asked",
  other: "Other",
};

export function isTakedownReason(value: unknown): value is TakedownReason {
  return typeof value === "string" && (TAKEDOWN_REASONS as readonly string[]).includes(value);
}

/** The label for a stored reason; an unknown code reads "Other". */
export function takedownReasonLabel(reason: string): string {
  return isTakedownReason(reason) ? TAKEDOWN_REASON_LABELS[reason] : TAKEDOWN_REASON_LABELS.other;
}

// S7: the message box is prefilled per reason; "Other" starts empty, so
// staff must write it.
export const TAKEDOWN_PREFILL_MESSAGES: Record<TakedownReason, string> = {
  copyright: "We received a copyright complaint about this book. Please reply with proof that you hold the rights.",
  content_rules: "This book breaks Librum's content rules, so we have taken it down.",
  broken_file: "The book file is wrong or doesn't open properly. Please upload a corrected file and write to us.",
  author_asked: "We took this book down at your request.",
  other: "",
};

// S7: a takedown opened from a report starts on the matching reason
// (src/lib/report-reasons.ts holds the readers' reasons).
export function takedownReasonForReport(reportReason: string | null | undefined): TakedownReason {
  if (reportReason === "Copyright infringement") return "copyright";
  if (reportReason === "Inappropriate or offensive content") return "content_rules";
  return "other";
}

// Mirrors book_takedowns_message_to_author_check and the RPC's own
// check; the RPC remains the authority.
export const TAKEDOWN_MESSAGE_MAX_LENGTH = 2000;

export const SUPPORT_EMAIL = "support@librum.al";
const QUESTIONS_LINE = `Questions? Write to ${SUPPORT_EMAIL}`;

export const TAKEN_DOWN_PUBLISH_MESSAGE = `Librum took this book down. You can't publish it again until we review it. ${QUESTIONS_LINE}`;

export const TAKEN_DOWN_DELETE_MESSAGE = `This book was taken down by Librum and can't be deleted until we review it. ${QUESTIONS_LINE}`;

// R1: authenticated holds SELECT on these columns of book_takedowns and
// no others, so `select *` or `select id` fails with 42501 for an
// author session. Every author-session read names exactly this list.
export const AUTHOR_TAKEDOWN_COLUMNS =
  "book_id, book_title, author_id, reason, message_to_author, bundle_ids, taken_down_at, lifted_at";

export type AuthorTakedown = {
  book_id: string | null;
  book_title: string;
  author_id: string | null;
  reason: string;
  message_to_author: string;
  bundle_ids: string[];
  taken_down_at: string;
  lifted_at: string | null;
};

/** An active takedown as the author sees it, with the bundle titles it unpublished. */
export type AuthorTakedownNotice = {
  takenDownAt: string;
  reason: string;
  message: string;
  bundleTitles: string[];
};

function withFinalStop(text: string): string {
  const trimmed = text.trim();
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * The author's notice, as separate lines in reading order:
 * "Taken down by Librum on <date>. Reason: <label>.", the message,
 * "We also unpublished: <titles>." (when any), and the questions line.
 */
export function buildAuthorTakedownNoticeLines(
  notice: AuthorTakedownNotice,
  formatDate: (iso: string) => string,
): string[] {
  const lines = [
    `Taken down by Librum on ${formatDate(notice.takenDownAt)}. Reason: ${takedownReasonLabel(notice.reason)}.`,
    withFinalStop(notice.message),
  ];
  if (notice.bundleTitles.length > 0) {
    lines.push(`We also unpublished: ${notice.bundleTitles.join(", ")}.`);
  }
  lines.push(QUESTIONS_LINE);
  return lines;
}

// ADMIN-3-REVIEW (S7, N7): "Send back" reuses this list with "Author
// asked" left out -- the same labels as Unpublish. The codes are what
// public.book_reviews.reason stores (book_reviews_reason_check), which
// takedown-reasons.test.ts checks against the migration.
export const SEND_BACK_REASONS = ["copyright", "content_rules", "broken_file", "other"] as const satisfies readonly TakedownReason[];

export type SendBackReason = (typeof SEND_BACK_REASONS)[number];

export function isSendBackReason(value: unknown): value is SendBackReason {
  return typeof value === "string" && (SEND_BACK_REASONS as readonly string[]).includes(value);
}

// N7: the message box is prefilled per reason; "Other" starts empty, so
// staff must write it.
export const SEND_BACK_PREFILL_MESSAGES: Record<SendBackReason, string> = {
  copyright:
    "We couldn't confirm you hold the rights to this book. Please reply with proof that you do, then send it for review again.",
  content_rules:
    "This book breaks Librum's content rules, so we can't publish it. Please read the rules, change the book and send it again.",
  broken_file:
    "The book file is wrong or doesn't open properly. Please upload a corrected file and send it for review again.",
  other: "",
};

// Mirrors book_reviews_message_to_author_check; the RPC is the authority.
export const SEND_BACK_MESSAGE_MAX_LENGTH = 2000;
