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

// Featured picks book list (Renato 2026-11-26, ff3 a): 10 books a page,
// ?page=N. Only plain whole numbers count; anything else is page 1.
export const LIBRUM_CHOICE_PAGE_SIZE = 10;

export function parseLibrumChoicePage(raw: unknown): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = typeof value === "string" && /^\d{1,6}$/.test(value) ? Number.parseInt(value, 10) : 1;
  return parsed >= 1 ? parsed : 1;
}

// The pager's links: the search is kept, page 1 has no ?page.
export function librumChoicePageHref(q: string, page: number): string {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return query ? `/admin/librum-choice?${query}` : "/admin/librum-choice";
}
