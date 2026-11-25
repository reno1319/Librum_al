// F5: the pure rules of the Featured picks admin search, kept out of the
// page so they are unit-testable without a render harness. LR1 patch 3
// (lr3-6 a, lr3-6b a): the Libraria banner replaced the "Librum's
// choice" strip, so its label rule is gone.

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
