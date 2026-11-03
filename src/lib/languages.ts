// LIBRUM 2.0 PUBLISHING-UX-1 PART B: the launch language vocabulary for
// a book's `language` field -- same simple "plain const array + derived
// type" pattern already used by genres.ts/contributor-roles.ts, not a
// localization framework and not a full ISO-639 selector (PUBLISHING-
// UX-1 Part A's own audit explicitly recommended against that).
//
// BD15 P1 (3 Nov 2026): Albanian and English only. The database now
// enforces the same set (books_language_check, migration
// 20261103200000), so a code added here needs that CHECK widened first.
export const LANGUAGES = [
  { code: "sq", label: "Shqip" },
  { code: "en", label: "Anglisht" },
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
