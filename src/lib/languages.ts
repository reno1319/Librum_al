// LIBRUM 2.0 PUBLISHING-UX-1 PART B: the launch language vocabulary for
// a book's `language` field -- same simple "plain const array + derived
// type" pattern already used by genres.ts/contributor-roles.ts, not a
// localization framework and not a full ISO-639 selector (PUBLISHING-
// UX-1 Part A's own audit explicitly recommended against that).
//
// This is product configuration, not a database invariant -- books.
// language (migration 044) carries no DB CHECK constraint precisely so
// that adding a fourth launch language later never requires a
// migration, only a change to this file plus whatever server-side
// validation already reads it (createBook()/updateBook() in
// src/app/(public)/dashboard/books/actions.ts).
export const LANGUAGES = [
  { code: "sq", label: "Albanian" },
  { code: "en", label: "English" },
  { code: "it", label: "Italian" },
] as const;

export type LanguageCode = (typeof LANGUAGES)[number]["code"];

export function isSupportedLanguage(value: string): value is LanguageCode {
  return LANGUAGES.some((language) => language.code === value);
}

// Falls back to the raw code itself for a value this file doesn't
// recognize (e.g. a future code seen by older deployed code, or bad
// data) rather than throwing or returning an empty string -- matches
// this codebase's established fail-safe-not-fail-loud convention for
// display helpers (see e.g. describeTransferReversalStatus()).
export function getLanguageLabel(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.label ?? code;
}
