// BD15 P2: the rules of the new editor's Details tab ("Të dhënat"), in
// one place for the browser (field messages before a save) and the
// server (the real check before any write). Pure: no Supabase, no
// server-only import. The database repeats the hard limits
// (migration 20261103200000: categories, 18+ with the children's
// categories, reading age, edition number, at most 3 contributors;
// migration 20261107120000: the book type's list).

import { GENRES } from "@/lib/genres";
import { isBookType, type BookType } from "@/lib/book-types";
import { isSupportedLanguage } from "@/lib/languages";
import { CONTRIBUTOR_ROLES, type ContributorRole } from "@/lib/contributor-roles";
import { isRightsBasis, RIGHTS_BASES } from "@/lib/rights-statements";
import {
  MISSING_ORIGINAL_AUTHOR_MESSAGE,
  ORIGINAL_AUTHOR_MAX_LENGTH,
  normalizeOriginalAuthor,
} from "@/lib/book-byline";
import { normalizeDescription } from "@/lib/book-description";
import type { RightsBasis } from "@/lib/types";

export const TITLE_MAX_LENGTH = 300;
export const SUBTITLE_MAX_LENGTH = 300;
export const MAX_CATEGORIES = 3;
export const MAX_KEYWORDS = 7;
export const KEYWORD_MAX_LENGTH = 50;
export const MAX_CONTRIBUTORS = 3;
export const CONTRIBUTOR_NAME_MAX_LENGTH = 120;
export const EDITION_NUMBER_MAX = 999;
export const READING_AGES = [3, 6, 9, 12, 14, 16, 18] as const;
export const ADULT_READING_AGE = 18;
// Q5 (Renato, 3 Nov): an 18+ book can't be in these two.
export const CHILDREN_CATEGORIES: readonly string[] = ["Për fëmijë", "Për të rinj"];

export const TITLE_REQUIRED_MESSAGE = "Shtoni një titull.";
export const TITLE_TOO_LONG_MESSAGE = `Titulli mund të ketë deri në ${TITLE_MAX_LENGTH} karaktere.`;
export const SUBTITLE_TOO_LONG_MESSAGE = `Nëntitulli mund të ketë deri në ${SUBTITLE_MAX_LENGTH} karaktere.`;
export const LANGUAGE_MESSAGE = "Zgjidhni gjuhën e librit.";
export const SERIES_POSITION_MESSAGE = "Numri në seri duhet të jetë numër i plotë, nga 1.";
export const EDITION_NUMBER_MESSAGE = `Numri i botimit duhet të jetë numër i plotë, nga 1 deri në ${EDITION_NUMBER_MAX}.`;
export const PEN_NAME_MESSAGE = "Zgjidhni një nga emrat tuaj të autorit.";
export const READING_AGE_MESSAGE = "Zgjidhni moshën nga lista.";
export const BOOK_TYPE_MESSAGE = "Zgjidhni llojin e librit nga lista.";
export const CATEGORIES_INVALID_MESSAGE = "Zgjidhni kategoritë nga lista.";
export const CATEGORIES_TOO_MANY_MESSAGE = `Zgjidhni deri në ${MAX_CATEGORIES} kategori.`;
export const ADULT_CATEGORIES_MESSAGE =
  "Një libër 18+ nuk mund të jetë te “Për fëmijë” ose “Për të rinj”. Hiqni këto kategori ose ndryshoni përgjigjen për 18+.";
export const KEYWORDS_TOO_MANY_MESSAGE = `Shkruani deri në ${MAX_KEYWORDS} fjalë kyçe.`;
export const KEYWORD_TOO_LONG_MESSAGE = `Çdo fjalë kyçe mund të ketë deri në ${KEYWORD_MAX_LENGTH} karaktere.`;
export const CONTRIBUTORS_TOO_MANY_MESSAGE = `Mund të shtoni deri në ${MAX_CONTRIBUTORS} kontribues.`;
export const CONTRIBUTOR_INVALID_MESSAGE = `Çdo kontribues ka një emër (deri në ${CONTRIBUTOR_NAME_MAX_LENGTH} karaktere) dhe një rol nga lista.`;
export const RIGHTS_INVALID_MESSAGE = "Zgjidhni të drejtat nga lista.";
export const ORIGINAL_AUTHOR_TOO_LONG_MESSAGE = `Autori origjinal mund të ketë deri në ${ORIGINAL_AUTHOR_MAX_LENGTH} karaktere`;
export { MISSING_ORIGINAL_AUTHOR_MESSAGE };

export type DetailsField =
  | "title"
  | "subtitle"
  | "language"
  | "seriesPosition"
  | "editionNumber"
  | "penNameId"
  | "description"
  | "readingAge"
  | "bookType"
  | "categories"
  | "keywords"
  | "contributors"
  | "rightsBasis"
  | "originalAuthor";

export type DetailsContributor = { id: string | null; name: string; role: ContributorRole };

export type BookDetails = {
  title: string;
  subtitle: string | null;
  language: "sq" | "en";
  seriesId: string | null;
  seriesPosition: number | null;
  editionNumber: number | null;
  penNameId: string | null;
  description: string;
  isAdult: boolean;
  readingAgeMin: number | null;
  // Upload notes C: null = not chosen yet (a draft may be saved so).
  bookType: BookType | null;
  categories: string[];
  keywords: string[];
  contributors: DetailsContributor[];
  rightsBasis: RightsBasis | null;
  originalAuthor: string | null;
};

export type DetailsResult =
  | { ok: true; details: BookDetails }
  | { ok: false; errors: Partial<Record<DetailsField, string>> };

// Only the plain text inputs the form sends; FormData from the browser
// and a plain object in tests both fit.
export type DetailsInput = {
  get(name: string): unknown;
  getAll(name: string): unknown[];
};

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const WHOLE_NUMBER = /^\d{1,9}$/;

export function splitKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const keyword = part.replace(/\s+/g, " ").trim();
    if (!keyword) continue;
    const key = keyword.toLocaleLowerCase("sq");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
  }
  return out;
}

export function parseBookDetails(input: DetailsInput): DetailsResult {
  const errors: Partial<Record<DetailsField, string>> = {};

  const title = str(input.get("title")).replace(/\s+/g, " ").trim();
  if (!title) errors.title = TITLE_REQUIRED_MESSAGE;
  else if (Array.from(title).length > TITLE_MAX_LENGTH) errors.title = TITLE_TOO_LONG_MESSAGE;

  const subtitleRaw = str(input.get("subtitle")).replace(/\s+/g, " ").trim();
  if (Array.from(subtitleRaw).length > SUBTITLE_MAX_LENGTH) errors.subtitle = SUBTITLE_TOO_LONG_MESSAGE;

  const languageRaw = str(input.get("language")) || "sq";
  if (!isSupportedLanguage(languageRaw)) errors.language = LANGUAGE_MESSAGE;

  const seriesId = str(input.get("seriesId")).trim() || null;
  const positionRaw = str(input.get("seriesPosition")).trim();
  let seriesPosition: number | null = null;
  if (seriesId && positionRaw) {
    if (!WHOLE_NUMBER.test(positionRaw) || Number(positionRaw) < 1) errors.seriesPosition = SERIES_POSITION_MESSAGE;
    else seriesPosition = Number(positionRaw);
  }

  const editionRaw = str(input.get("editionNumber")).trim();
  let editionNumber: number | null = null;
  if (editionRaw) {
    if (!WHOLE_NUMBER.test(editionRaw) || Number(editionRaw) < 1 || Number(editionRaw) > EDITION_NUMBER_MAX) {
      errors.editionNumber = EDITION_NUMBER_MESSAGE;
    } else {
      editionNumber = Number(editionRaw);
    }
  }

  const penNameId = str(input.get("penNameId")).trim() || null;

  const description = normalizeDescription(str(input.get("description")));
  if (!description.ok) errors.description = description.message;

  const isAdult = str(input.get("isAdult")) === "yes";

  const ageRaw = str(input.get("readingAge")).trim();
  let readingAgeMin: number | null = null;
  if (ageRaw) {
    const age = Number(ageRaw);
    if (!WHOLE_NUMBER.test(ageRaw) || !(READING_AGES as readonly number[]).includes(age)) {
      errors.readingAge = READING_AGE_MESSAGE;
    } else {
      readingAgeMin = age;
    }
  }
  if (isAdult) readingAgeMin = ADULT_READING_AGE;

  const bookTypeRaw = str(input.get("bookType")).trim();
  let bookType: BookType | null = null;
  if (bookTypeRaw) {
    if (isBookType(bookTypeRaw)) bookType = bookTypeRaw;
    else errors.bookType = BOOK_TYPE_MESSAGE;
  }

  const categories: string[] = [];
  for (const value of input.getAll("categories")) {
    const category = str(value);
    if (!(GENRES as readonly string[]).includes(category)) {
      errors.categories = CATEGORIES_INVALID_MESSAGE;
      continue;
    }
    if (!categories.includes(category)) categories.push(category);
  }
  if (!errors.categories && categories.length > MAX_CATEGORIES) errors.categories = CATEGORIES_TOO_MANY_MESSAGE;
  if (!errors.categories && isAdult && categories.some((c) => CHILDREN_CATEGORIES.includes(c))) {
    errors.categories = ADULT_CATEGORIES_MESSAGE;
  }

  const keywords = splitKeywords(str(input.get("keywords")));
  if (keywords.length > MAX_KEYWORDS) errors.keywords = KEYWORDS_TOO_MANY_MESSAGE;
  else if (keywords.some((k) => Array.from(k).length > KEYWORD_MAX_LENGTH)) errors.keywords = KEYWORD_TOO_LONG_MESSAGE;

  const names = input.getAll("contributorName").map(str);
  const roles = input.getAll("contributorRole").map(str);
  const ids = input.getAll("contributorId").map(str);
  const contributors: DetailsContributor[] = [];
  if (names.length !== roles.length || ids.length !== names.length) {
    errors.contributors = CONTRIBUTOR_INVALID_MESSAGE;
  } else {
    for (let i = 0; i < names.length; i++) {
      const name = names[i].replace(/\s+/g, " ").trim();
      const role = roles[i];
      if (!name && !ids[i]) continue; // an empty new row is ignored
      if (
        !name ||
        Array.from(name).length > CONTRIBUTOR_NAME_MAX_LENGTH ||
        !(CONTRIBUTOR_ROLES as readonly string[]).includes(role)
      ) {
        errors.contributors = CONTRIBUTOR_INVALID_MESSAGE;
        continue;
      }
      contributors.push({ id: ids[i] || null, name, role: role as ContributorRole });
    }
    if (!errors.contributors && contributors.length > MAX_CONTRIBUTORS) errors.contributors = CONTRIBUTORS_TOO_MANY_MESSAGE;
  }

  const basisRaw = str(input.get("rightsBasis"));
  let rightsBasis: RightsBasis | null = null;
  if (basisRaw) {
    if (isRightsBasis(basisRaw)) rightsBasis = basisRaw;
    else errors.rightsBasis = RIGHTS_INVALID_MESSAGE;
  }
  const originalAuthorRaw = normalizeOriginalAuthor(str(input.get("originalAuthor")));
  const originalAuthor: string | null = originalAuthorRaw || null;
  // Optional for own rights (a translation the author has permission
  // for); required for both public-domain choices (BD3 patch 4, 5a).
  if (originalAuthor && Array.from(originalAuthor).length > ORIGINAL_AUTHOR_MAX_LENGTH) {
    errors.originalAuthor = ORIGINAL_AUTHOR_TOO_LONG_MESSAGE;
  } else if (rightsBasis && rightsBasis !== "own_rights" && !originalAuthor) {
    errors.originalAuthor = MISSING_ORIGINAL_AUTHOR_MESSAGE;
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return {
    ok: true,
    details: {
      title,
      subtitle: subtitleRaw || null,
      language: languageRaw as "sq" | "en",
      seriesId,
      seriesPosition,
      editionNumber,
      penNameId,
      description: description.ok ? description.value : "",
      isAdult,
      readingAgeMin,
      bookType,
      categories,
      keywords,
      contributors,
      rightsBasis,
      originalAuthor,
    },
  };
}

// The Details tab is "done" (Plotësuar) once the book has what review
// needs from it: a title, the book type (upload notes C), at least one
// category, a description and the rights choice (with the original author for a public-domain one).
// Everything else is optional.
export type DetailsCompleteness = {
  title: string | null | undefined;
  bookType: string | null | undefined;
  categories: readonly string[] | null | undefined;
  description: string | null | undefined;
  rightsBasis: RightsBasis | null | undefined;
  originalAuthor: string | null | undefined;
};

export function missingDetails(book: DetailsCompleteness): string[] {
  return missingDetailItems(book).map((m) => m.label);
}

// Upload notes 2 (Enkelejd 11-06): the same list with each item's field,
// so the Details tab can mark the empty ones red.
export function missingDetailItems(book: DetailsCompleteness): { field: DetailsField; label: string }[] {
  const missing: { field: DetailsField; label: string }[] = [];
  if (!book.title?.trim()) missing.push({ field: "title", label: "Titulli" });
  if (!isBookType(book.bookType)) missing.push({ field: "bookType", label: "Lloji i librit" });
  if (!book.categories || book.categories.length === 0) missing.push({ field: "categories", label: "Të paktën një kategori" });
  if (!book.description?.trim()) missing.push({ field: "description", label: "Përshkrimi" });
  if (!book.rightsBasis) missing.push({ field: "rightsBasis", label: "Të drejtat" });
  else if (book.rightsBasis !== "own_rights" && !book.originalAuthor?.trim())
    missing.push({ field: "originalAuthor", label: "Autori origjinal" });
  return missing;
}

export { RIGHTS_BASES };
