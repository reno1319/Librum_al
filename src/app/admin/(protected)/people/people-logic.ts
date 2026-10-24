import { isUuid } from "../books/book-admin-logic";

// PEOPLE-1: pure helpers for /admin/people and /admin/people/[id] (the
// list's filters, search and paging, the row shape admin_list_people()
// returns, and the labels each column shows), kept out of the pages so
// each is directly unit-testable -- the same extraction as
// book-admin-logic.ts.

export { isUuid };

export const PEOPLE_PAGE_SIZE = 50;
// admin_list_people() refuses a longer query; the form never sends one.
export const PEOPLE_SEARCH_MAX_LENGTH = 200;

export type PeopleKind = "everyone" | "authors" | "readers" | "suspended";

export const PEOPLE_KINDS: { value: PeopleKind; label: string }[] = [
  { value: "everyone", label: "Everyone" },
  { value: "authors", label: "Authors" },
  { value: "readers", label: "Readers" },
  { value: "suspended", label: "Suspended" },
];

// Mirrors admin_list_people()'s RETURNS TABLE (migration 20261023090000).
// Server-side only: the email is never sent to any page but these two.
export type PersonRow = {
  user_id: string;
  display_name: string;
  email: string | null;
  account_type: string;
  is_staff: boolean;
  live_books: number;
  in_review_books: number;
  draft_books: number;
  paid_sales: number;
  owned_books: number;
  has_bank_account: boolean;
  joined_at: string;
  suspended: boolean;
  total_count: number;
};

function first(raw: unknown): unknown {
  return Array.isArray(raw) ? raw[0] : raw;
}

export function parsePeopleKind(raw: unknown): PeopleKind {
  const value = first(raw);
  return value === "authors" || value === "readers" || value === "suspended" ? value : "everyone";
}

export function parsePeopleSearch(raw: unknown): string {
  const value = first(raw);
  if (typeof value !== "string") return "";
  return value.trim().slice(0, PEOPLE_SEARCH_MAX_LENGTH).trim();
}

export function parsePeoplePage(raw: unknown): number {
  const value = first(raw);
  const parsed = typeof value === "string" && /^\d{1,6}$/.test(value) ? Number.parseInt(value, 10) : 1;
  return parsed >= 1 ? parsed : 1;
}

export function peopleListHref(kind: PeopleKind, q: string, page = 1): string {
  const params = new URLSearchParams();
  if (kind !== "everyone") params.set("show", kind);
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/admin/people?${query}` : "/admin/people";
}

/** "Author", "Reader" or "Staff" (staff first: they can't be suspended). */
export function personTypeLabel(person: Pick<PersonRow, "account_type" | "is_staff">): string {
  if (person.is_staff) return "Staff";
  return person.account_type === "author" ? "Author" : "Reader";
}

/**
 * The Books column, as on the mockup: "4 live", "1 in review",
 * "4 live · 1 in review", "2 drafts", "0 live" for an author with
 * nothing; "-" for a reader with no books.
 */
export function personBooksLabel(
  person: Pick<PersonRow, "account_type" | "live_books" | "in_review_books" | "draft_books">,
): string {
  const parts: string[] = [];
  if (person.live_books > 0) parts.push(`${person.live_books} live`);
  if (person.in_review_books > 0) parts.push(`${person.in_review_books} in review`);
  if (parts.length > 0) return parts.join(" · ");
  if (person.draft_books > 0) return person.draft_books === 1 ? "1 draft" : `${person.draft_books} drafts`;
  return person.account_type === "author" ? "0 live" : "-";
}

/** Paid sales for an author ("0" included), "-" for a reader. */
export function personSalesLabel(person: Pick<PersonRow, "account_type" | "paid_sales">): string {
  return person.account_type === "author" || person.paid_sales > 0 ? String(person.paid_sales) : "-";
}

/** "Added" / "Not added" for an author, "-" for a reader. Never the IBAN. */
export function personBankLabel(person: Pick<PersonRow, "account_type" | "has_bank_account">): string {
  if (person.has_bank_account) return "Added";
  return person.account_type === "author" ? "Not added" : "-";
}

export function personStatusLabel(person: Pick<PersonRow, "suspended">): "Suspended" | "Active" {
  return person.suspended ? "Suspended" : "Active";
}

/** "1 person" / "12 people". */
export function peopleCountLabel(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}
