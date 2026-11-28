// Amazon book page, patch 2 (Renato 11-28, design r7): the pure rules
// behind the shelf under the book ("Mund t'ju pëlqejnë edhe" with its
// chips), the "I ri" card tag and the shelf's "Faqja 1 nga 3" line. No
// database, no browser: every rule here is unit-tested.

// bp5 a: "I ri" = published on Librum in the last 30 days.
export const NEW_BOOK_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Item 20: a live book that went live on Librum less than 30 days ago.
// A pre-order, a draft or a book without a real published_at never is.
export function isNewOnLibrum(
  book: { status?: string | null; published_at?: string | null },
  now: Date,
): boolean {
  if (book.status !== "published" || !book.published_at) return false;
  const published = Date.parse(book.published_at);
  if (Number.isNaN(published)) return false;
  const age = now.getTime() - published;
  return age >= 0 && age < NEW_BOOK_DAYS * DAY_MS;
}

// Up to three pages of seven on a computer (Amazon's row).
export const SHELF_ROW_LIMIT = 21;

// Two rows with the same books in the same order: the second chip would
// only repeat the first, so it is left out.
export function sameBookIds(a: readonly { id: string }[], b: readonly { id: string }[]): boolean {
  return a.length === b.length && a.every((book, i) => book.id === b[i]?.id);
}

// Item 23: "Faqja X nga Y" from the row's scroll position. One page is
// the visible width; the last page counts once the row reaches its end.
export function shelfPage(scrollLeft: number, visibleWidth: number, scrollWidth: number): { page: number; total: number } {
  if (!(visibleWidth > 0) || !(scrollWidth > 0)) return { page: 1, total: 1 };
  const total = Math.max(1, Math.ceil((scrollWidth - 4) / visibleWidth));
  const atEnd = scrollLeft + visibleWidth >= scrollWidth - 4;
  const page = atEnd ? total : Math.min(total, Math.floor((scrollLeft + 4) / visibleWidth) + 1);
  return { page: Math.max(1, page), total };
}

export function shelfPageText({ page, total }: { page: number; total: number }): string {
  return `Faqja ${page} nga ${total}`;
}
