import { escapeIlikePattern } from "@/lib/librum-choice-logic";
import { formatCatalogPriceAll, resolveCatalogPriceState } from "@/lib/catalog-price";
import {
  TAKEDOWN_MESSAGE_MAX_LENGTH,
  isTakedownReason,
  type TakedownReason,
} from "@/lib/takedown-reasons";

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

export type BooksFilter = "all" | "live" | "draft" | "taken_down";

export const BOOKS_FILTERS: { value: BooksFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "live", label: "Live" },
  { value: "draft", label: "Draft" },
  { value: "taken_down", label: "Taken down" },
];

function first(raw: unknown): unknown {
  return Array.isArray(raw) ? raw[0] : raw;
}

export function parseBooksFilter(raw: unknown): BooksFilter {
  const value = first(raw);
  return value === "live" || value === "draft" || value === "taken_down" ? value : "all";
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

export type BookStateLabel = "Live" | "Draft" | "Taken down";

export function bookStateLabel(status: string, takenDown: boolean): BookStateLabel {
  if (takenDown) return "Taken down";
  return status === "published" ? "Live" : "Draft";
}

// ------------------------------------------------------------
// Book page (C)
// ------------------------------------------------------------

/** "Live · Paid · 499 ALL", "Live · Free", "Draft" or "Taken down". */
export function describeBookEyebrow(book: { status: string; price_all: number | null }, takenDown: boolean): string {
  if (takenDown) return "Taken down";
  if (book.status !== "published") return "Draft";
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
