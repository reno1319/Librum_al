// F5: the pure rules around the "Librum's choice" pick, kept out of the
// pages so each one is unit-testable without a render harness.

// Bookstore (settled D7): the feature block says "Librum's choice" only
// while a pick exists, is published (getLibrumChoiceBook's own filter) and
// has a price -- the Bookstore lists only priced books, and an unpriced
// pick would render "Buy · Price unavailable". Otherwise it shows the
// newest book as "New on Librum", exactly as before F5.
export const LIBRUMS_CHOICE_LABEL = "Librum's choice";
export const NEW_ON_LIBRUM_LABEL = "New on Librum";

export function resolveBookstoreFeature<T extends { price_all: number | null }>(
  pick: T | null,
  newest: T | null,
): { book: T; label: string } | null {
  if (pick && pick.price_all != null) return { book: pick, label: LIBRUMS_CHOICE_LABEL };
  if (newest) return { book: newest, label: NEW_ON_LIBRUM_LABEL };
  return null;
}

// Homepage (Renato 10:17Z, Q2 = b): the pick may lead the hero shelf only
// if it would be on the homepage at all -- exactly the homepage list's
// own filter (published, priced (0 = free counts), with a cover).
export function qualifiesForHomepage(book: {
  status: string | null;
  price_all: number | null;
  cover_path: string | null;
}): boolean {
  return book.status === "published" && book.price_all != null && book.cover_path != null;
}

// The homepage list with the pick first, then every other book in its
// existing order (newest first), never the same book twice. The pick may
// be older than the fetched newest books, so it is passed in on its own;
// when it is also in the list, the list's own entry is used. Without a
// pick the list is returned unchanged.
export function orderHomepageBooks<T extends { id: string }>(newest: T[], pick: T | null): T[] {
  if (!pick) return newest;
  const first = newest.find((book) => book.id === pick.id) ?? pick;
  return [first, ...newest.filter((book) => book.id !== pick.id)];
}

// Admin search (C1): a plain GET ?q=, trimmed and capped, then escaped
// for an ILIKE pattern so `%`, `_` and `\` match themselves.
export const LIBRUM_CHOICE_SEARCH_MAX_LENGTH = 100;

export function parseLibrumChoiceSearch(raw: unknown): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return "";
  return value.trim().slice(0, LIBRUM_CHOICE_SEARCH_MAX_LENGTH).trim();
}

export function escapeIlikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}
