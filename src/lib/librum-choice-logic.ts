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
