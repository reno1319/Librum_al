// Buyer reader (Renato 11-15, b): a buyer reads their whole book in the
// page-turning reader. Small pure helpers shared by the read route
// (src/app/api/books/[id]/read/route.ts) and the reader.

// 1a: the one-time check before the first open, while the 14 days run.
export const OPEN_CANCEL_CONFIRM = "Kur e hapni librin, nuk mund ta anuloni më këtë blerje (njësoj si me shkarkimin).";

/**
 * 1a: while the buyer's 14-day cancel window is open, the first open
 * must be confirmed. True when the request carries the confirmation.
 */
export function readConfirmed(query: URLSearchParams): boolean {
  return query.get("accept") === "1";
}

// Audit r1 B2: the read answer must fit under Vercel's 4.5 MB response
// limit, with room to spare; a bigger book is refused before recording.
export const MAX_READ_RESPONSE_BYTES = 4_000_000;

// 3a: the reading place is kept in this browser only, per book, as a
// share of the book's pages (0..1), so it survives a font-size change.
export const READER_POSITION_PREFIX = "librum-reader-place:";

export function positionStorageKey(bookId: string): string {
  return `${READER_POSITION_PREFIX}${bookId}`;
}

/** A stored place, or null for anything that is not a number in 0..1. */
export function parseSavedPosition(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}
