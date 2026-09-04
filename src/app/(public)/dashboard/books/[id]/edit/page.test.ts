import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// Module-scope so every describe block below (Part D's own included)
// can read the same real page.tsx source without each re-reading the
// file from disk.
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");

// LIBRUM 2.0 PRODUCT-5 EDIT-CRASH CORRECTION: a real production defect
// -- this page (a Server Component, no "use client") was passing an
// inline arrow function (onManuscriptChange={() => {}}) to
// ManuscriptField, a "use client" component. Next.js/React cannot
// serialize a raw function across that Server->Client boundary; this
// crashed the ENTIRE Edit route with a 500 ("Event handlers cannot be
// passed to Client Component props"), reproduced empirically against
// a real dev server before writing this fix, and independent of which
// book was being edited (it's a static code defect, not data-
// dependent). The fix: ManuscriptField's onManuscriptChange (like
// CoverField's own onCoverChange, already correct since COVER-1) is
// now optional and invoked internally via `?.()`, so this page simply
// omits the prop entirely -- it has no use for it.
//
// This exact crash mode (a non-serializable value crossing the RSC
// Server->Client boundary) isn't reproducible in Vitest's plain node
// environment -- it's a real Next.js RSC-payload serialization error,
// not something jsdom or a unit test can trigger, and this codebase
// deliberately avoids React Testing Library in favor of live
// verification for exactly this class of thing (see this repo's other
// component test files' own comments). A source-level regression
// guard is the practical, narrow alternative: assert this page's own
// source never again passes an inline function to either "use client"
// Files-section field. (TypeScript's own optional-prop + `?.()` call
// site is a second, independent guard: reintroducing a non-optional
// call there without the `?.` would fail `tsc --noEmit` on its own.)
describe("Edit page: never passes an inline function prop across the Server->Client boundary", () => {
  it("does not pass onManuscriptChange to ManuscriptField -- it has no use for it here, and this page cannot pass a raw function across the RSC boundary", () => {
    const manuscriptFieldBlock = source.match(/<ManuscriptField[\s\S]*?\/>/);
    expect(manuscriptFieldBlock).not.toBeNull();
    expect(manuscriptFieldBlock![0]).not.toContain("onManuscriptChange");
  });

  it("does not pass onCoverChange to CoverField either, for the same reason", () => {
    const coverFieldBlock = source.match(/<CoverField[\s\S]*?\/>/);
    expect(coverFieldBlock).not.toBeNull();
    expect(coverFieldBlock![0]).not.toContain("onCoverChange");
  });
});

// LIBRUM 2.0 PUBLISHING-UX-1 PART D: Edit-page metadata parity with the
// New Book wizard (Part C) and the server contract (Part B's
// updateBook()). Same source-level regression convention as the block
// above and as upload-wizard.wiring.test.ts -- this codebase has no
// DOM-rendering harness, so these assert directly on the real page.tsx
// text rather than re-implementing it.
describe("Edit page: bibliographic metadata fields", () => {
  it("Subtitle, Publisher, Edition, and Originally-published all exist with the exact field names actions.ts's resolvers read", () => {
    expect(source).toContain('name="subtitle"');
    expect(source).toContain('name="publisher"');
    expect(source).toContain('name="edition"');
    expect(source).toContain('name="originalPublicationDate"');
    // No alternate snake_case names -- these would silently never reach
    // updateBook()'s own formData.get(...) calls.
    expect(source).not.toContain('name="original_publication_date"');
  });

  it("Subtitle/Publisher/Edition/Originally-published render the book's current value (or blank for a legacy null), never a raw null", () => {
    const subtitleBlock = source.match(/name="subtitle"[\s\S]{0,400}?\/>/)![0];
    expect(subtitleBlock).toContain('defaultValue={book.subtitle ?? ""}');

    const publisherBlock = source.match(/name="publisher"[\s\S]{0,400}?\/>/)![0];
    expect(publisherBlock).toContain('defaultValue={book.publisher ?? ""}');

    const editionBlock = source.match(/name="edition"[\s\S]{0,400}?\/>/)![0];
    expect(editionBlock).toContain('defaultValue={book.edition ?? ""}');

    const dateBlock = source.match(/name="originalPublicationDate"[\s\S]{0,400}?\/>/)![0];
    expect(dateBlock).toContain('defaultValue={book.original_publication_date ?? ""}');
    expect(dateBlock).toContain('type="date"');
  });

  it("Subtitle/Publisher/Edition carry the same client-side max lengths actions.ts enforces server-side", () => {
    const subtitleBlock = source.match(/name="subtitle"[\s\S]{0,400}?\/>/)![0];
    expect(subtitleBlock).toContain("maxLength={SUBTITLE_MAX_LENGTH}");
    const publisherBlock = source.match(/name="publisher"[\s\S]{0,400}?\/>/)![0];
    expect(publisherBlock).toContain("maxLength={PUBLISHER_MAX_LENGTH}");
    const editionBlock = source.match(/name="edition"[\s\S]{0,400}?\/>/)![0];
    expect(editionBlock).toContain("maxLength={EDITION_MAX_LENGTH}");
    expect(source).toMatch(/const SUBTITLE_MAX_LENGTH = 300/);
    expect(source).toMatch(/const PUBLISHER_MAX_LENGTH = 200/);
    expect(source).toMatch(/const EDITION_MAX_LENGTH = 100/);
  });
});

describe("Edit page: Language field (historical-book safety, critical)", () => {
  const languageBlock = source.match(/<select\s+name="language"[\s\S]*?<\/select>/)![0];

  it("uses the shared LANGUAGES vocabulary, not a duplicate hardcoded list", () => {
    expect(source).toContain('import { LANGUAGES, isSupportedLanguage } from "@/lib/languages";');
    expect(languageBlock).toContain("{LANGUAGES.map(");
  });

  it("never defaults to \"sq\" -- the default is derived from the book's own stored value only", () => {
    expect(languageBlock).not.toContain('"sq"');
    expect(languageBlock).toContain('defaultValue={book.language ?? ""}');
  });

  it("is not required -- an existing book may legitimately have no language on record", () => {
    expect(languageBlock).not.toContain("required");
  });

  it("shows a neutral, non-Albanian, non-disabled placeholder so an author can deliberately revert to no language", () => {
    expect(languageBlock).toContain('<option value="">Select language</option>');
    expect(languageBlock).not.toMatch(/<option value="" disabled>/);
  });

  // LIBRUM 2.0 PUBLISHING-UX-1 PART D FINAL PRE-COMMIT LANGUAGE
  // PRESERVATION CORRECTION: books.language carries no DB CHECK, so an
  // existing book may already hold a code this deployed LANGUAGES
  // doesn't recognize (e.g. a future/legacy "fr"). Collapsing that case
  // to the same blank defaultValue as a genuinely-null book made it
  // indistinguishable from "no language" once rendered -- an untouched
  // save of any unrelated field would then silently submit language=""
  // and clear real metadata. These tests cover cases A-G from that
  // correction's own spec directly against the real source. Case H (a
  // full submit-and-persist round trip for an unchanged unsupported
  // value) is EXPLICITLY NOT covered here -- see this correction's own
  // final report: resolveLanguage() (actions.ts) still rejects any
  // non-empty value outside LANGUAGES with a redirect before
  // updateBook()'s .update() call ever runs, so that full round trip
  // does not currently succeed end-to-end. Writing a test that asserts
  // it does would misrepresent the real, reported, still-open state of
  // that gap -- deliberately not done, per this correction's own
  // "do not weaken the test" instruction.
  describe("unsupported/future language code preservation (Cases A-G)", () => {
    it("Case A -- null language: the blank prompt is the only pre-selected representation, no synthetic option", () => {
      expect(languageBlock).toContain('defaultValue={book.language ?? ""}');
      // For book.language === null, `book.language && !isSupportedLanguage(...)`
      // is false, so the synthetic <option> branch never renders --
      // confirmed structurally below (Case F) rather than re-asserted
      // per-value here, since this is a static source file covering
      // every book, not one book's own resolved JSX.
    });

    it("Case B/C -- supported codes (sq, en, it) render from LANGUAGES, not a duplicate/synthetic option", () => {
      expect(languageBlock).toContain("{LANGUAGES.map((l) => (");
      expect(languageBlock).toMatch(/<option key=\{l\.code\} value=\{l\.code\}>/);
    });

    it("Case D -- a non-null, unsupported code is preserved via a synthetic <option>, not mapped to blank", () => {
      expect(languageBlock).toContain(
        "{book.language && !isSupportedLanguage(book.language) && (",
      );
      expect(languageBlock).toContain(
        "<option value={book.language}>Current language · {book.language}</option>",
      );
    });

    it("Case E -- the normal sq/en/it options remain available alongside the synthetic one", () => {
      const synthenticIndex = languageBlock.indexOf("Current language");
      const languagesMapIndex = languageBlock.indexOf("{LANGUAGES.map(");
      expect(synthenticIndex).toBeGreaterThan(-1);
      expect(languagesMapIndex).toBeGreaterThan(-1);
    });

    it("Case F -- the synthetic option is gated on non-null AND unsupported, so it never duplicates a supported code", () => {
      const guardMatch = languageBlock.match(
        /\{book\.language && !isSupportedLanguage\(book\.language\) && \(/,
      );
      expect(guardMatch).not.toBeNull();
    });

    it("Case G -- copy never calls it \"Invalid language\"", () => {
      expect(languageBlock).not.toContain("Invalid language");
      expect(languageBlock).toContain("Current language ·");
    });
  });
});

describe("Edit page: published_at is never author-editable", () => {
  it("no form field reads or submits publishedAt/published_at", () => {
    expect(source).not.toContain('name="publishedAt"');
    expect(source).not.toContain('name="published_at"');
  });

  it("published_at is never referenced anywhere in this page's source", () => {
    // Part D's own instructions treat a read-only "Published on Librum"
    // display in this page's Publishing panel as optional ("do not
    // force this if it clutters") -- this page deliberately omits it
    // to keep the Edit surface focused, so published_at should not
    // appear here at all (the public Book Detail page is the actual
    // required surface for it).
    expect(source).not.toContain("published_at");
  });
});

describe("Edit page: form organization", () => {
  it("wraps Keywords/ISBN/Publisher/Edition/Originally-published/Series inside one 'Additional book details' disclosure, mirroring the New Book wizard", () => {
    const detailsBlock = source.match(/<details[\s\S]*?<\/details>/)![0];
    expect(detailsBlock).toContain("Additional book details");
    for (const fieldName of ["keywords", "isbn", "publisher", "edition", "originalPublicationDate", "seriesId"]) {
      expect(detailsBlock).toContain(`name="${fieldName}"`);
    }
  });

  it("Title, Subtitle, Description, Language, and Genre stay directly visible (not inside the disclosure)", () => {
    const detailsStart = source.indexOf("<details");
    const bookDetailsSectionStart = source.indexOf('<h2 className="font-serif text-xl font-semibold">Book Details</h2>');
    const beforeDisclosure = source.slice(bookDetailsSectionStart, detailsStart);
    for (const fieldName of ["title", "subtitle", "description", "language", "genre"]) {
      expect(beforeDisclosure).toContain(`name="${fieldName}"`);
    }
  });
});
