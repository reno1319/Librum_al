import type { PenNameRef } from "@/lib/pen-names";
import type { RightsBasis } from "@/lib/types";

// PEN-NAMES-1 (migration 20261019184512): the byline shown for one book
// is its pen name -- every book has one (the author's default pen name
// when no other was chosen) -- read through the public_pen_names view,
// embedded in the book query as `pen:public_pen_names(id, name)`. The
// account behind it is never read here.
//
// BD3 patch 4 (Renato 1 Nov, 1a 2a 4a): a translated or public-domain
// book can name its "Autori origjinal" (books.original_author, through
// public_books). When it does, the byline is that original author, and
// the pen name becomes the translator line on the book page and the
// download page (resolveTranslatorLine). Cards show the byline only.
//
// Used everywhere a BOOK's author name shows (book cards, shelves, the
// book page, the read sample, the hero shelf, Librum's choice) and for
// the EPUB dc:creator. null only when the embed is missing.
export const BOOK_PEN_NAME_EMBED = "pen:public_pen_names(id, name)";

export const ORIGINAL_AUTHOR_MAX_LENGTH = 200;

// 5a: the message when a public-domain choice comes without one (the
// wizard and the server action say the same).
export const MISSING_ORIGINAL_AUTHOR_MESSAGE =
  "Shkruani autorin origjinal. Kërkohet kur vepra është në domenin publik.";

// 2a: the hint under the box (Renato's wording).
export const ORIGINAL_AUTHOR_HINT = "Vetëm nëse libri është përkthim.";
// The Edit page has no live check, so it says the rule up front.
export const ORIGINAL_AUTHOR_EDIT_NOTE = "E detyrueshme për një vepër në domenin publik.";

// Audit r1 (L1): any run of whitespace -- line and paragraph separators
// (U+2028/9) included, which some database locales count as control
// characters -- becomes one space; C0/C1 controls and invisible format
// characters (soft hyphen, zero-width, bidi controls, BOM) are dropped,
// so a name cannot render blank or reversed; then trimmed.
export function normalizeOriginalAuthor(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

// The translator line, on the book page and the download page.
export const TRANSLATED_BY = "Përktheu:";

type BylineBook = { pen?: PenNameRef | null; original_author?: string | null };

// The original author, trimmed, or null when the book names none.
// Audit r1 (N1): one equal to the book's own pen name (ignoring case and
// outer spaces) is no original author -- the pen name already is the
// byline, keeps its link, and "nga X / Përktheu: X" would be odd.
export function resolveOriginalAuthor(book: BylineBook | null | undefined): string | null {
  const value = book?.original_author;
  if (typeof value !== "string" || !value.trim()) return null;
  const original = value.trim();
  const pen = book?.pen?.name?.trim();
  if (pen && pen.toLocaleLowerCase("sq") === original.toLocaleLowerCase("sq")) return null;
  return original;
}

// The pen name the book is published under (author pages, "About the
// author", "More by", the Librum last page). Never the original author.
export function resolveBookPenName(book: BylineBook | null | undefined): string | null {
  return book?.pen?.name ?? null;
}

export function resolveBookByline(book: BylineBook | null | undefined): string | null {
  return resolveOriginalAuthor(book) ?? resolveBookPenName(book);
}

// Staff screens (audit r1, M1/L6): both names, so staff always see who
// uploaded the book and what readers see as its author.
export function resolveStaffByline(book: BylineBook | null | undefined): string | null {
  const pen = resolveBookPenName(book);
  const original = resolveOriginalAuthor(book);
  if (!original) return pen;
  return pen ? `${pen} · original author: ${original}` : `original author: ${original}`;
}

// Who holds the translation's ©, on the download page ("Përkthimi ©"):
// the Translator names the author typed, else the pen name (the uploader
// translated it themselves). Used for the two bases that have such a
// line (public_domain_original, and own_rights with translators or an
// original author).
export function resolveTranslatorNames(translators: readonly string[], penName: string): string {
  const named = translators.map((t) => t.trim()).filter(Boolean);
  return named.length > 0 ? named.join(", ") : penName.trim();
}

// The "Përktheu:" line under an original author (book page, download
// page, JSON-LD). 1a (16:05Z): the Translator names typed, else the pen
// name -- except (audit r1, H1) for a "public_domain" book, which can be
// an untranslated original: there only typed translators are named,
// never the uploader. When the basis could not be read (`basisKnown`
// false), the pen name is never claimed as translator either. null = no
// line.
export function resolveTranslatorLine(
  translators: readonly string[],
  penName: string | null,
  basis: RightsBasis | null,
  basisKnown = true,
): string | null {
  const named = translators.map((t) => t.trim()).filter(Boolean);
  if (named.length > 0) return named.join(", ");
  if (!basisKnown || basis === "public_domain") return null;
  return penName?.trim() || null;
}
