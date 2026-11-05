import { escapeIlikePattern } from "@/lib/librum-choice-logic";
import { formatCatalogPriceAll, resolveCatalogPriceState } from "@/lib/catalog-price";
import {
  SEND_BACK_MESSAGE_MAX_LENGTH,
  TAKEDOWN_MESSAGE_MAX_LENGTH,
  isSendBackReason,
  isTakedownReason,
  type SendBackReason,
  type TakedownReason,
} from "@/lib/takedown-reasons";
import { REVIEW_CHECKLIST_ITEMS } from "@/lib/book-review-copy";
import type { PublishGateRefusal } from "@/lib/publish-readiness";

// ADMIN-2-TAKEDOWN: pure helpers for /admin/books and /admin/books/[id]
// (list filters and search, the book page's eyebrow, the Unpublish form
// and the RPC error copy), kept out of the pages so each is directly
// unit-testable -- the same extraction as report-review-logic.ts.

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// ------------------------------------------------------------
// Books list (B, S5)
// ------------------------------------------------------------

export const BOOKS_PAGE_SIZE = 50;

// ADMIN-3-REVIEW (G): "In review" = a draft with a pending review;
// "Draft" excludes books in review and taken-down books.
export type BooksFilter = "all" | "live" | "in_review" | "draft" | "taken_down";

export const BOOKS_FILTERS: { value: BooksFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "in_review", label: "In review" },
  { value: "draft", label: "Draft" },
  { value: "taken_down", label: "Taken down" },
];

function first(raw: unknown): unknown {
  return Array.isArray(raw) ? raw[0] : raw;
}

export function parseBooksFilter(raw: unknown): BooksFilter {
  const value = first(raw);
  return value === "live" || value === "in_review" || value === "draft" || value === "taken_down" ? value : "all";
}

export function parseBooksPage(raw: unknown): number {
  const value = first(raw);
  const parsed = typeof value === "string" && /^\d{1,6}$/.test(value) ? Number.parseInt(value, 10) : 1;
  return parsed >= 1 ? parsed : 1;
}

export const BOOKS_SEARCH_MAX_LENGTH = 100;

export function parseBooksSearch(raw: unknown): string {
  const value = first(raw);
  if (typeof value !== "string") return "";
  return value.trim().slice(0, BOOKS_SEARCH_MAX_LENGTH).trim();
}

/** The ILIKE pattern for a search: `%`, `_` and `\` match themselves. */
export function booksSearchPattern(q: string): string {
  return `%${escapeIlikePattern(q)}%`;
}

// A PostgREST filter value in double quotes, so `,`, `.`, `:` and
// parentheses in the search are data, never filter syntax; `\` and `"`
// are backslash-escaped inside the quotes.
export function quotePostgrestValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * S5: the books `.or()` filter for a search: the title matches, or the
 * book's pen name is one of `penNameIds`, or its author is one of
 * `authorIds` (both found by their own escaped ILIKE first). The search
 * text only ever appears quoted; the id lists are database ids, and
 * anything that is not a uuid is dropped.
 */
export function buildBooksSearchOrFilter(q: string, penNameIds: string[], authorIds: string[]): string {
  const parts = [`title.ilike.${quotePostgrestValue(booksSearchPattern(q))}`];
  const pens = penNameIds.filter(isUuid);
  const authors = authorIds.filter(isUuid);
  if (pens.length > 0) parts.push(`pen_name_id.in.(${pens.join(",")})`);
  if (authors.length > 0) parts.push(`author_id.in.(${authors.join(",")})`);
  return parts.join(",");
}

export function booksListHref(filter: BooksFilter, q: string, page = 1): string {
  const params = new URLSearchParams();
  if (filter !== "all") params.set("status", filter);
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/admin/books?${query}` : "/admin/books";
}

export type BookStateLabel = "Live" | "In review" | "Draft" | "Taken down";

export function bookStateLabel(status: string, takenDown: boolean, inReview = false): BookStateLabel {
  if (takenDown) return "Taken down";
  if (status === "published") return "Live";
  return inReview ? "In review" : "Draft";
}

// ------------------------------------------------------------
// Book page (C)
// ------------------------------------------------------------

/** "Live · Paid · 499 ALL", "Live · Free", "In review", "Draft" or "Taken down". */
export function describeBookEyebrow(
  book: { status: string; price_all: number | null },
  takenDown: boolean,
  inReview = false,
): string {
  if (takenDown) return "Taken down";
  if (book.status !== "published") return inReview ? "In review" : "Draft";
  const state = resolveCatalogPriceState(book.price_all);
  if (state === "free") return "Live · Free";
  if (state === "paid") return `Live · Paid · ${formatCatalogPriceAll(book.price_all as number)}`;
  return "Live · Price unavailable";
}

/** ?report=<id> counts only when it names an OPEN report of this book. */
export function resolveTakedownReport<T extends { id: string }>(raw: unknown, openReports: readonly T[]): T | null {
  const value = first(raw);
  if (!isUuid(value)) return null;
  return openReports.find((report) => report.id.toLowerCase() === value.toLowerCase()) ?? null;
}

// ------------------------------------------------------------
// The Unpublish form
// ------------------------------------------------------------

export type UnpublishFormValidation =
  | { ok: true; reason: TakedownReason; message: string; reportId: string | null }
  | { ok: false; error: string };

export const CHOOSE_REASON_MESSAGE = "Choose a reason.";
export const WRITE_MESSAGE_MESSAGE = "Write a message to the author.";
export const MESSAGE_TOO_LONG_MESSAGE = `Please keep the message under ${TAKEDOWN_MESSAGE_MAX_LENGTH} characters.`;

export function validateUnpublishForm(formData: FormData): UnpublishFormValidation {
  const reason = formData.get("reason");
  if (!isTakedownReason(reason)) return { ok: false, error: CHOOSE_REASON_MESSAGE };
  const rawMessage = formData.get("message");
  const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
  if (message.length === 0) return { ok: false, error: WRITE_MESSAGE_MESSAGE };
  if (message.length > TAKEDOWN_MESSAGE_MAX_LENGTH) return { ok: false, error: MESSAGE_TOO_LONG_MESSAGE };
  const rawReport = formData.get("reportId");
  const reportId = isUuid(rawReport) ? rawReport : null;
  return { ok: true, reason, message, reportId };
}

// ------------------------------------------------------------
// RPC errors -- never raw database text in the browser.
// ------------------------------------------------------------

export const GENERIC_TAKEDOWN_ERROR_MESSAGE = "Something went wrong. Please try again.";
export const TAKEDOWN_RPC_NOT_AUTHENTICATED_MESSAGE = "not authenticated";

const KNOWN_TAKEDOWN_RPC_ERRORS: Record<string, string> = {
  "not authorized": "You don't have permission to unpublish books.",
  "invalid reason": CHOOSE_REASON_MESSAGE,
  "invalid message": WRITE_MESSAGE_MESSAGE,
  "no book found for this id": "This book no longer exists.",
  "this book is already taken down": "This book is already taken down.",
  "no open report for this book": "That report is no longer open for this book. Unpublish without it, or open it again from Book reports.",
  "this book is not taken down": "This book is not taken down.",
};

export function mapTakedownRpcError(error: { code?: string | null; message?: string | null } | null | undefined): string {
  // S3: two staff locking the same bundles and book in a crossed order.
  if (error?.code === "40P01") return "Please try again.";
  const message = error?.message?.trim();
  if (!message) return GENERIC_TAKEDOWN_ERROR_MESSAGE;
  return KNOWN_TAKEDOWN_RPC_ERRORS[message] ?? GENERIC_TAKEDOWN_ERROR_MESSAGE;
}

export const UNPUBLISHED_SUCCESS_MESSAGE = "Book unpublished. The author can't publish it again until you allow it.";
export const UNPUBLISHED_WITH_REPORT_SUCCESS_MESSAGE =
  "Book unpublished and the report resolved. The author can't publish it again until you allow it.";
export const ALLOWED_AGAIN_SUCCESS_MESSAGE = "The author can publish this book again.";

// ------------------------------------------------------------
// ADMIN-3-REVIEW (H): Approve and Send back
// ------------------------------------------------------------

export const CHECKLIST_INCOMPLETE_MESSAGE = "Tick all three checks before you approve.";
export const SEND_BACK_MESSAGE_TOO_LONG_MESSAGE = `Please keep the message under ${SEND_BACK_MESSAGE_MAX_LENGTH} characters.`;
export const GENERIC_REVIEW_ERROR_MESSAGE = "Something went wrong. Please try again.";
export const APPROVED_SUCCESS_MESSAGE = "Book approved. It's live in the Bookstore now.";
export const SENT_BACK_SUCCESS_MESSAGE = "Book sent back. The author sees your message on their Dashboard.";
export const AUTHOR_CHANGED_FILES_MESSAGE = "The author changed the file or cover. Reload and check again.";
export const AUTHOR_CHANGED_BOOK_MESSAGE = "The author changed the book. Reload and check again.";

/**
 * The canonical checklist the RPC and the table's check require: its four
 * stored keys, exactly. BD15 P5b-3a (Renato 11-04, b): staff tick three
 * boxes; the one rights box ("rights_ok") stands for both
 * not_someone_elses_work and rights_declared, so no migration.
 */
export const APPROVED_CHECKLIST = {
  cover_is_fine: true,
  file_opens: true,
  not_someone_elses_work: true,
  rights_declared: true,
} as const;

export type ApproveFormValidation =
  | {
      ok: true;
      reviewId: string;
      bookId: string;
      filePath: string | null;
      coverPath: string | null;
      checklist: typeof APPROVED_CHECKLIST;
    }
  | { ok: false; error: string };

function optionalPath(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

// Every box ticked (server-validated: a crafted post without them is
// refused here and by the RPC). The paths are the values the page
// rendered, so the RPC can refuse an approval of files staff never saw.
export function validateApproveForm(formData: FormData): ApproveFormValidation {
  const reviewId = formData.get("reviewId");
  const bookId = formData.get("bookId");
  if (!isUuid(reviewId) || !isUuid(bookId)) return { ok: false, error: GENERIC_REVIEW_ERROR_MESSAGE };
  for (const item of REVIEW_CHECKLIST_ITEMS) {
    if (formData.get(item.key) !== "on") return { ok: false, error: CHECKLIST_INCOMPLETE_MESSAGE };
  }
  return {
    ok: true,
    reviewId,
    bookId,
    filePath: optionalPath(formData.get("filePath")),
    coverPath: optionalPath(formData.get("coverPath")),
    checklist: APPROVED_CHECKLIST,
  };
}

export type SendBackFormValidation =
  | { ok: true; reviewId: string; bookId: string; reason: SendBackReason; message: string }
  | { ok: false; error: string };

export function validateSendBackForm(formData: FormData): SendBackFormValidation {
  const reviewId = formData.get("reviewId");
  const bookId = formData.get("bookId");
  if (!isUuid(reviewId) || !isUuid(bookId)) return { ok: false, error: GENERIC_REVIEW_ERROR_MESSAGE };
  const reason = formData.get("reason");
  if (!isSendBackReason(reason)) return { ok: false, error: CHOOSE_REASON_MESSAGE };
  const rawMessage = formData.get("message");
  const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
  if (message.length === 0) return { ok: false, error: WRITE_MESSAGE_MESSAGE };
  if (message.length > SEND_BACK_MESSAGE_MAX_LENGTH) return { ok: false, error: SEND_BACK_MESSAGE_TOO_LONG_MESSAGE };
  return { ok: true, reviewId, bookId, reason, message };
}

const KNOWN_REVIEW_RPC_ERRORS: Record<string, string> = {
  "not authorized": "You don't have permission to review books.",
  "invalid reason": CHOOSE_REASON_MESSAGE,
  "invalid message": WRITE_MESSAGE_MESSAGE,
  "invalid checklist": CHECKLIST_INCOMPLETE_MESSAGE,
  "no review found for this id": "This review no longer exists.",
  "this review is no longer waiting": "This book is no longer waiting for review. Reload to see what changed.",
  "this book is already published": "This book is already live.",
  "this book is taken down": "This book is taken down. Allow it again before you approve it.",
  "the author changed the file or cover": AUTHOR_CHANGED_FILES_MESSAGE,
  "the author changed the book": AUTHOR_CHANGED_BOOK_MESSAGE,
};

// PEOPLE-1 audit N3 (Renato's 4b): the books trigger refuses publishing
// a suspended author's book with SQLSTATE LB464, which the approve RPC
// does not catch; matched by code, as its message is the author-facing one.
export const AUTHOR_SUSPENDED_APPROVE_MESSAGE =
  "This author's account is suspended. Lift the suspension before approving.";

// BD15 P7 (migration 20261105180000): public-domain editions. LB499 is
// the staff functions' own refusal, written for staff, so its text is
// shown as it is; the others are matched by code.
export const PD_NOT_LINKED_APPROVE_MESSAGE =
  "This is a public-domain book. Link it to a work in the Public-domain edition box before you approve it.";
export const PD_NOT_PICKED_APPROVE_MESSAGE =
  "This book is linked to a public-domain work, so it can only go live as that work's edition. Approve it from this page again.";
// Audit r1 N4: linking a priced book (books_pd_price_check).
export const PD_PRICE_MESSAGE =
  "This book has a price. A public-domain edition is free, so send it back and ask the author to make it free first.";
export const PD_EDITION_INVALID_MESSAGE = "Choose a work, or give the new work's title and original author.";
export const PD_SERIES_MESSAGE =
  "A public-domain edition without the editor mention can't be in a series or a bundle. Ask the author to take it out, or give the mention.";

// staff_set_pd_edition / admin_approve_pd_edition's own refusals (LB499),
// already written for staff; any other text is the generic error.
const KNOWN_PD_RPC_ERRORS: Record<string, string> = {
  "This live book is not a public-domain edition.": "This live book is not a public-domain edition.",
  "A live edition stays with its work. Only its editor mention can change.":
    "A live edition stays with its work. Only its editor mention can change.",
  "That public-domain work no longer exists.": "That public-domain work no longer exists.",
  "A new work needs its title and its original author.": "A new work needs its title and its original author.",
  'Only a book whose rights choice is "public domain" can be a work\'s edition.':
    'Only a book whose rights choice is "public domain" can be a work\'s edition.',
  "Link this book to a public-domain work first.": PD_NOT_LINKED_APPROVE_MESSAGE,
  "invalid public-domain edition": PD_EDITION_INVALID_MESSAGE,
};

export function mapReviewRpcError(error: { code?: string | null; message?: string | null } | null | undefined): string {
  if (error?.code === "40P01") return "Please try again.";
  if (error?.code === "LB464") return AUTHOR_SUSPENDED_APPROVE_MESSAGE;
  if (error?.code === "LB498") return PD_NOT_LINKED_APPROVE_MESSAGE;
  if (error?.code === "LB485") return PD_NOT_PICKED_APPROVE_MESSAGE;
  if (error?.code === "LB487" || (error?.code === "23514" && error.message?.includes("books_pd_series_check"))) {
    return PD_SERIES_MESSAGE;
  }
  if (error?.code === "23514" && error.message?.includes("books_pd_price_check")) return PD_PRICE_MESSAGE;
  if (error?.code === "LB499") return KNOWN_PD_RPC_ERRORS[error.message?.trim() ?? ""] ?? GENERIC_REVIEW_ERROR_MESSAGE;
  const message = error?.message?.trim();
  if (!message) return GENERIC_REVIEW_ERROR_MESSAGE;
  return KNOWN_REVIEW_RPC_ERRORS[message] ?? GENERIC_REVIEW_ERROR_MESSAGE;
}

// M2: the shared publish gate's refusal, said to staff -- an approval
// never publishes a book its author could not.
export function approveReadinessMessage(reason: PublishGateRefusal): string {
  switch (reason) {
    case "missing_all_price":
      return "This book has no price yet. The author must set one before it can go live.";
    case "missing_description":
      return "This book has no description yet. The author must add one before it can go live.";
    case "missing_rights":
      return "The author hasn't chosen the rights yet, so the book can't go live.";
    case "rights_unavailable":
      return "Couldn't check the book's rights. Please try again.";
    case "paid_mode_required":
      return "Paid publishing isn't available right now, so this paid book can't go live.";
  }
}

// BD15 P7: the Public-domain edition box. "existing" links the book to
// a work picked from the list, "new" creates the work, "unlink" undoes a
// draft's link, "credit" changes only the editor mention (a live
// edition). The RPC (staff_set_pd_edition) re-checks all of it.
export const PD_EDITION_SAVED_MESSAGE = "Public-domain edition saved.";
export const PD_EDITION_FORM_ERROR_MESSAGE = PD_EDITION_INVALID_MESSAGE;
const PD_WORK_TITLE_MAX_LENGTH = 300;
const PD_WORK_AUTHOR_MAX_LENGTH = 200;

export type PdEditionFormValidation =
  | {
      ok: true;
      bookId: string;
      workId: string | null;
      workTitle: string | null;
      workOriginalAuthor: string | null;
      editorCredit: boolean;
    }
  | { ok: false; error: string };

function trimmedText(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function validatePdEditionForm(formData: FormData): PdEditionFormValidation {
  const bookId = formData.get("bookId");
  if (!isUuid(bookId)) return { ok: false, error: GENERIC_REVIEW_ERROR_MESSAGE };
  const editorCredit = formData.get("editorCredit") === "on";
  const mode = formData.get("mode");
  if (mode === "unlink") {
    return { ok: true, bookId, workId: null, workTitle: null, workOriginalAuthor: null, editorCredit: false };
  }
  if (mode === "existing" || mode === "credit") {
    const workId = formData.get("workId");
    if (!isUuid(workId)) return { ok: false, error: PD_EDITION_FORM_ERROR_MESSAGE };
    return { ok: true, bookId, workId, workTitle: null, workOriginalAuthor: null, editorCredit };
  }
  if (mode === "new") {
    const workTitle = trimmedText(formData.get("workTitle"));
    const workOriginalAuthor = trimmedText(formData.get("workOriginalAuthor"));
    if (
      !workTitle ||
      !workOriginalAuthor ||
      workTitle.length > PD_WORK_TITLE_MAX_LENGTH ||
      workOriginalAuthor.length > PD_WORK_AUTHOR_MAX_LENGTH
    ) {
      return { ok: false, error: PD_EDITION_FORM_ERROR_MESSAGE };
    }
    return { ok: true, bookId, workId: null, workTitle, workOriginalAuthor, editorCredit };
  }
  return { ok: false, error: PD_EDITION_FORM_ERROR_MESSAGE };
}
