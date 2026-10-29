import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// Module-scope so every describe block below (Part D's own included)
// can read the same real page.tsx source without each re-reading the
// file from disk.
const source = readFileSync(path.join(__dirname, "page.tsx"), "utf8");

// APP A EXHAUSTIVE AUDIT: declared at module scope (not inside a
// describe block) so vitest's vi.mock hoisting can never leave the mock
// factories referencing not-yet-initialized bindings.
const CREATE_CLIENT_SENTINEL = new Error("CREATE_CLIENT_CALLED");
const mockCreateClient = vi.fn(() => {
  throw CREATE_CLIENT_SENTINEL;
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("../../actions", () => ({
  updateBook: vi.fn(), addContributor: vi.fn(), removeContributor: vi.fn(),
  publishBook: vi.fn(), unpublishBook: vi.fn(), deleteBook: vi.fn(),
}));

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

    const dateBlock = source.match(/kind="pastDate"[\s\S]{0,400}?\/>/)![0];
    expect(dateBlock).toContain('name="originalPublicationDate"');
    expect(dateBlock).toContain('defaultValue={book.original_publication_date ?? ""}');
    // FIX1 (X9): the checked field renders type="date" for kind="pastDate".
    expect(dateBlock).toContain('kind="pastDate"');
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

// ALBANIAN-9 (Renato 10-28 "1. a"): the language picker is gone. The
// Edit form sends no "language" field, so updateBook() leaves the stored
// books.language untouched (resolveLanguageForUpdate "omit"): a book that
// already holds "en", "it" or an unknown code keeps it on every save.
describe("Edit page: no Language field (stored language never touched)", () => {
  it("renders no language control and imports no language vocabulary", () => {
    expect(source).not.toMatch(/name="language"/);
    expect(source).not.toContain("@/lib/languages");
  });

  it("does not keep a language value in the form draft", () => {
    const draftFields = source.match(/const EDIT_BOOK_DRAFT_FIELDS = \[[\s\S]*?\] as const;/)![0];
    expect(draftFields).not.toContain('"language"');
    expect(draftFields).toContain('"genre"');
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
  it("wraps Keywords/ISBN/Publisher/Edition/Originally-published/Series inside one 'Të dhëna të tjera për librin' disclosure, mirroring the New Book wizard", () => {
    const detailsBlock = source.match(/<details[\s\S]*?<\/details>/)![0];
    expect(detailsBlock).toContain("Të dhëna të tjera për librin");
    for (const fieldName of ["keywords", "isbn", "publisher", "edition", "originalPublicationDate", "seriesId"]) {
      expect(detailsBlock).toContain(`name="${fieldName}"`);
    }
  });

  it("Title, Subtitle, Description and Genre stay directly visible (not inside the disclosure)", () => {
    const detailsStart = source.indexOf("<details");
    const bookDetailsSectionStart = source.indexOf('<h2 className="font-serif text-xl font-normal">Të dhënat e librit</h2>');
    expect(bookDetailsSectionStart).toBeGreaterThan(-1);
    const beforeDisclosure = source.slice(bookDetailsSectionStart, detailsStart);
    for (const fieldName of ["title", "subtitle", "description", "genre"]) {
      expect(beforeDisclosure).toContain(`name="${fieldName}"`);
    }
  });
});

// APP A EXHAUSTIVE AUDIT: this page renders books.price_cents for
// editing (found by the exhaustive schema-sensitive route audit, not
// listed in V3 §3's own inventory) -- proves the maintenance gate at
// runtime, since "no page-level Supabase call occurs" is a runtime
// claim source-string matching alone can't establish.
describe("EditBookPage: maintenance-mode gate", () => {
  const BOOK_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase calls", async () => {
    const { default: EditBookPage } = await import("./page");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const element = await EditBookPage({
      params: Promise.resolve({ id: BOOK_ID }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);

    expect(html).toContain("Mirëmbajtje e planifikuar");
    expect(html).toContain("përkohësisht i padisponueshëm për mirëmbajtje të planifikuar");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("the notice contains no book id, price, or other configuration/identifier value", async () => {
    const { default: EditBookPage } = await import("./page");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const element = await EditBookPage({
      params: Promise.resolve({ id: BOOK_ID }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);

    expect(html).not.toContain(BOOK_ID);
    expect(html).not.toMatch(/\$\d/);
    expect(html.length).toBeLessThan(600);
  });

  it("maintenance mode off (unset) preserves existing behavior -- the page still reaches Supabase", async () => {
    vi.unstubAllEnvs();
    const { default: EditBookPage } = await import("./page");
    await expect(
      EditBookPage({ params: Promise.resolve({ id: BOOK_ID }), searchParams: Promise.resolve({}) }),
    ).rejects.toBe(CREATE_CLIENT_SENTINEL);
    expect(mockCreateClient).toHaveBeenCalledOnce();
  });
});
