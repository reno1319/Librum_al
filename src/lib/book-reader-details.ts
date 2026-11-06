// BD15 P8: what the reader side shows of the BD15 book details --
// categories, 18+, reading age and edition number -- as pure helpers, so
// the book page, the cards and the bundle page read them one way.
//
// Wording is Renato's Q3 (5 Nov). 18+ is a label only (plan Q5), and
// shows on book and bundle cards too (P8 Q1 a). The database keeps an
// 18+ book out of "Për fëmijë" and "Për të rinj"
// (books_adult_categories_check, migration 20261103200000).

import { descriptionPlainText } from "@/lib/book-description";

export const ADULT_TAG = "18+";
export const ADULT_DETAIL_VALUE = "18+ (për të rritur)";
export const ADULT_DETAIL_LABEL = "Përmbajtja";
export const READING_AGE_LABEL = "Mosha";
export const EDITION_LABEL = "Botimi";

// The two categories for young readers (src/lib/genres.ts spelling).
export const YOUNG_READER_CATEGORIES = ["Për fëmijë", "Për të rinj"] as const;

type CategorySource = { categories?: string[] | null; genre?: string | null };

// The book's categories in their saved order (the first is the primary,
// kept in `genre`). A row the P1 backfill did not reach falls back to its
// genre alone; blanks and repeats are dropped.
export function bookCategories(book: CategorySource): string[] {
  const source =
    book.categories && book.categories.length > 0
      ? book.categories
      : book.genre
        ? [book.genre]
        : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of source) {
    if (typeof value !== "string" || value.trim() === "" || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function categoriesLabel(count: number): string {
  return count > 1 ? "Zhanret" : "Zhanri";
}

// P8 Q2 a: a book for children or teens never shows 18+ books on its
// "Ju mund të pëlqeni" shelf.
export function isYoungReaderBook(book: CategorySource): boolean {
  return bookCategories(book).some((c) =>
    (YOUNG_READER_CATEGORIES as readonly string[]).includes(c),
  );
}

// "12+ vjeç", or null when there is no reading age, or when the book is
// 18+ (its reading age is always 18 and the Përmbajtja row says so).
export function readingAgeValue(book: {
  reading_age_min?: number | null;
  is_adult?: boolean | null;
}): string | null {
  if (book.is_adult) return null;
  const age = book.reading_age_min;
  if (typeof age !== "number" || !Number.isInteger(age) || age < 1) return null;
  return `${age}+ vjeç`;
}

// The new whole-number edition, else the old free-text edition (kept
// read-only by P1 for older books), else nothing.
export function editionValue(book: {
  edition_number?: number | null;
  edition?: string | null;
}): string | null {
  const n = book.edition_number;
  if (typeof n === "number" && Number.isInteger(n) && n >= 1) return String(n);
  const legacy = book.edition?.trim();
  return legacy ? legacy : null;
}

// F1 D2 a: a bundle is 18+ when any of its PUBLISHED books is. A member
// the visitor cannot read (null) or one that is not published does not
// count -- the author previewing their own bundle sees the public answer.
export function bundleIsAdult(
  members:
    | readonly { books: { is_adult?: boolean | null; status?: string | null } | null }[]
    | null
    | undefined,
): boolean {
  return (members ?? []).some(
    (m) => m.books !== null && m.books.status === "published" && m.books.is_adult === true,
  );
}

// The rich description as one line of plain text, for meta tags,
// schema.org data and card snippets: no "**" or "*" marks, no list
// syntax, whitespace folded.
export function descriptionSnippet(stored: string | null | undefined): string {
  if (!stored) return "";
  return descriptionPlainText(stored).replace(/\s+/g, " ").trim();
}
