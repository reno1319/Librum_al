import { describe, expect, it } from "vitest";
import {
  ADULT_CATEGORIES_MESSAGE,
  BOOK_TYPE_MESSAGE,
  CATEGORIES_INVALID_MESSAGE,
  CATEGORIES_TOO_MANY_MESSAGE,
  CONTRIBUTORS_TOO_MANY_MESSAGE,
  CONTRIBUTOR_INVALID_MESSAGE,
  EDITION_NUMBER_MESSAGE,
  KEYWORDS_TOO_MANY_MESSAGE,
  LANGUAGE_MESSAGE,
  MISSING_ORIGINAL_AUTHOR_MESSAGE,
  READING_AGE_MESSAGE,
  RIGHTS_INVALID_MESSAGE,
  SERIES_POSITION_MESSAGE,
  TITLE_REQUIRED_MESSAGE,
  TITLE_TOO_LONG_MESSAGE,
  missingDetailItems,
  missingDetails,
  parseBookDetails,
  splitKeywords,
} from "./book-details";
import { DESCRIPTION_TOO_LONG_MESSAGE } from "./book-description";

function form(values: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(values)) {
    for (const v of Array.isArray(value) ? value : [value]) fd.append(key, v);
  }
  return fd;
}

function errorsOf(values: Record<string, string | string[]>) {
  const result = parseBookDetails(form({ title: "Titull", ...values }));
  return result.ok ? {} : result.errors;
}

describe("parseBookDetails", () => {
  it("a title alone is a valid draft, with the defaults", () => {
    const result = parseBookDetails(form({ title: "  Dimri   në Valbonë " }));
    expect(result).toEqual({
      ok: true,
      details: {
        title: "Dimri në Valbonë",
        subtitle: null,
        language: "sq",
        seriesId: null,
        seriesPosition: null,
        editionNumber: null,
        penNameId: null,
        description: "",
        isAdult: false,
        readingAgeMin: null,
        bookType: null,
        categories: [],
        keywords: [],
        contributors: [],
        rightsBasis: null,
        originalAuthor: null,
      },
    });
  });

  it("requires a title of at most 300 characters", () => {
    expect(errorsOf({ title: "   " }).title).toBe(TITLE_REQUIRED_MESSAGE);
    expect(errorsOf({ title: "a".repeat(301) }).title).toBe(TITLE_TOO_LONG_MESSAGE);
    expect(errorsOf({ title: "ë".repeat(300) }).title).toBeUndefined();
  });

  it("accepts sq and en only", () => {
    expect(errorsOf({ language: "en" }).language).toBeUndefined();
    expect(errorsOf({ language: "de" }).language).toBe(LANGUAGE_MESSAGE);
  });

  it("reads the series position only with a series, as a whole number from 1", () => {
    expect(errorsOf({ seriesPosition: "x" })).toEqual({});
    expect(errorsOf({ seriesId: "s1", seriesPosition: "0" }).seriesPosition).toBe(SERIES_POSITION_MESSAGE);
    expect(errorsOf({ seriesId: "s1", seriesPosition: "2.5" }).seriesPosition).toBe(SERIES_POSITION_MESSAGE);
    const ok = parseBookDetails(form({ title: "T", seriesId: "s1", seriesPosition: "3" }));
    expect(ok.ok && ok.details.seriesPosition).toBe(3);
  });

  it("accepts an edition number from 1 to 999", () => {
    for (const bad of ["0", "1000", "-1", "1e2", "2.0"]) {
      expect(errorsOf({ editionNumber: bad }).editionNumber).toBe(EDITION_NUMBER_MESSAGE);
    }
    const ok = parseBookDetails(form({ title: "T", editionNumber: "2" }));
    expect(ok.ok && ok.details.editionNumber).toBe(2);
  });

  it("stores the description in its canonical form and limits it", () => {
    const ok = parseBookDetails(form({ title: "T", description: "  **a**\n\n\n- b " }));
    expect(ok.ok && ok.details.description).toBe("**a**\n\n- b");
    expect(errorsOf({ description: "a".repeat(4001) }).description).toBe(DESCRIPTION_TOO_LONG_MESSAGE);
  });

  // Upload notes C: one of the eight types, or none yet (a draft saves).
  it("reads the book type: one of the list, or none", () => {
    const none = parseBookDetails(form({ title: "T" }));
    expect(none.ok && none.details.bookType).toBeNull();
    const roman = parseBookDetails(form({ title: "T", bookType: "Roman" }));
    expect(roman.ok && roman.details.bookType).toBe("Roman");
    const nonfiction = parseBookDetails(form({ title: "T", bookType: "Jo-artistik (studim, tjetër)" }));
    expect(nonfiction.ok && nonfiction.details.bookType).toBe("Jo-artistik (studim, tjetër)");
    expect(errorsOf({ bookType: "Tregime" }).bookType).toBe(BOOK_TYPE_MESSAGE);
    expect(errorsOf({ bookType: "roman" }).bookType).toBe(BOOK_TYPE_MESSAGE);
    // NFD "ë" (e + U+0308) is not the stored NFC value.
    expect(errorsOf({ bookType: "Drame\u0308" }).bookType).toBe(BOOK_TYPE_MESSAGE);
  });

  it("keeps categories in the order chosen, without repeats, up to 3 of the list", () => {
    const ok = parseBookDetails(form({ title: "T", categories: ["Poezi", "Histori", "Poezi"] }));
    expect(ok.ok && ok.details.categories).toEqual(["Poezi", "Histori"]);
    expect(errorsOf({ categories: ["Poezi", "Histori", "Horror", "Fantazi"] }).categories).toBe(CATEGORIES_TOO_MANY_MESSAGE);
    expect(errorsOf({ categories: ["Poetry"] }).categories).toBe(CATEGORIES_INVALID_MESSAGE);
  });

  it("18+ forces reading age 18 and refuses the children's categories (Q5)", () => {
    const ok = parseBookDetails(form({ title: "T", isAdult: "yes", readingAge: "6" }));
    expect(ok.ok && ok.details).toMatchObject({ isAdult: true, readingAgeMin: 18 });
    expect(errorsOf({ isAdult: "yes", categories: ["Për të rinj"] }).categories).toBe(ADULT_CATEGORIES_MESSAGE);
    expect(errorsOf({ isAdult: "no", categories: ["Për fëmijë"] })).toEqual({});
  });

  it("accepts reading ages from the fixed list only", () => {
    expect(errorsOf({ readingAge: "7" }).readingAge).toBe(READING_AGE_MESSAGE);
    const ok = parseBookDetails(form({ title: "T", readingAge: "12" }));
    expect(ok.ok && ok.details.readingAgeMin).toBe(12);
  });

  it("allows up to 7 keywords (repeats and blanks don't count)", () => {
    expect(splitKeywords(" mal, Mal ,, dimër ,familje ")).toEqual(["mal", "dimër", "familje"]);
    expect(errorsOf({ keywords: "a,b,c,d,e,f,g" }).keywords).toBeUndefined();
    expect(errorsOf({ keywords: "a,b,c,d,e,f,g,h" }).keywords).toBe(KEYWORDS_TOO_MANY_MESSAGE);
  });

  it("reads up to 3 contributors with a name and a known role; an empty new row is ignored", () => {
    const ok = parseBookDetails(
      form({
        title: "T",
        contributorId: ["c1", ""],
        contributorName: [" Besnik  Hoxha ", ""],
        contributorRole: ["Editor", "Translator"],
      }),
    );
    expect(ok.ok && ok.details.contributors).toEqual([{ id: "c1", name: "Besnik Hoxha", role: "Editor" }]);
    expect(
      errorsOf({ contributorId: [""], contributorName: ["X"], contributorRole: ["Boss"] }).contributors,
    ).toBe(CONTRIBUTOR_INVALID_MESSAGE);
    expect(
      errorsOf({
        contributorId: ["", "", "", ""],
        contributorName: ["a", "b", "c", "d"],
        contributorRole: ["Editor", "Editor", "Editor", "Editor"],
      }).contributors,
    ).toBe(CONTRIBUTORS_TOO_MANY_MESSAGE);
    expect(errorsOf({ contributorId: ["", ""], contributorName: ["a"], contributorRole: ["Editor"] }).contributors).toBe(
      CONTRIBUTOR_INVALID_MESSAGE,
    );
  });

  it("requires the original author for both public-domain choices, not for own rights", () => {
    expect(errorsOf({ rightsBasis: "public_domain" }).originalAuthor).toBe(MISSING_ORIGINAL_AUTHOR_MESSAGE);
    expect(errorsOf({ rightsBasis: "public_domain_original" }).originalAuthor).toBe(MISSING_ORIGINAL_AUTHOR_MESSAGE);
    expect(errorsOf({ rightsBasis: "own_rights" })).toEqual({});
    expect(errorsOf({ rightsBasis: "stolen" }).rightsBasis).toBe(RIGHTS_INVALID_MESSAGE);
    const ok = parseBookDetails(form({ title: "T", rightsBasis: "public_domain", originalAuthor: " Naim  Frashëri " }));
    expect(ok.ok && ok.details).toMatchObject({ rightsBasis: "public_domain", originalAuthor: "Naim Frashëri" });
  });
});

describe("missingDetails (the Details tab's done state)", () => {
  const complete = {
    title: "T",
    bookType: "Roman",
    categories: ["Poezi"],
    description: "Rreth librit",
    rightsBasis: "own_rights" as const,
    originalAuthor: null,
  };

  it("is empty for a complete book", () => {
    expect(missingDetails(complete)).toEqual([]);
  });

  it("names what is missing", () => {
    expect(missingDetails({ ...complete, categories: null, description: " ", rightsBasis: null })).toEqual([
      "Të paktën një kategori",
      "Përshkrimi",
      "Të drejtat",
    ]);
    expect(missingDetails({ ...complete, rightsBasis: "public_domain" })).toEqual(["Autori origjinal"]);
  });

  // Upload notes C: the book type is needed before review, and only a
  // value on the list counts.
  it("needs the book type", () => {
    expect(missingDetails({ ...complete, bookType: null })).toEqual(["Lloji i librit"]);
    expect(missingDetails({ ...complete, bookType: "" })).toEqual(["Lloji i librit"]);
    expect(missingDetails({ ...complete, bookType: "Tregime" })).toEqual(["Lloji i librit"]);
    expect(missingDetailItems({ ...complete, bookType: null, categories: null }).map((m) => m.field)).toEqual([
      "bookType",
      "categories",
    ]);
  });
});
