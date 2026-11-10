import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ALL-CUTOVER APP-A: focused coverage of the maintenance gate on this
// schema-sensitive public discovery page (V3 §3) -- not a general audit
// of Bookstore's own search/filter/sort logic, which has no page-level
// test file today.
const SENTINEL = new Error("CREATE_CLIENT_CALLED");
const mockCreateClient = vi.fn((): unknown => {
  throw SENTINEL;
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => { throw new Error("ADMIN_CLIENT_CALLED"); } }));

const { default: BookstorePage } = await import("./page");

function noParams() {
  return { searchParams: Promise.resolve({}) };
}

describe("BookstorePage: maintenance-mode gate", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase calls", async () => {
    const element = await BookstorePage(noParams());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain("Mirëmbajtje e planifikuar");
    expect(html).toContain("përkohësisht i padisponueshëm për mirëmbajtje të planifikuar");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("the notice contains no price, book title, or other configuration/identifier value", async () => {
    const element = await BookstorePage(noParams());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).not.toMatch(/\$\d/);
    expect(html).not.toMatch(/ALL_CUTOVER_MAINTENANCE_MODE/);
    expect(html.length).toBeLessThan(600);
  });

  it("maintenance mode off (unset) preserves existing behavior -- the page still reaches Supabase", async () => {
    vi.unstubAllEnvs();
    await expect(BookstorePage(noParams())).rejects.toBe(SENTINEL);
    expect(mockCreateClient).toHaveBeenCalledOnce();
  });
});

// ============================================================
// REDESIGN STEP 3: the unfiltered bookstore leads with the newest book
// under one label (Renato D1/D7), then "I ri në Librum" starting after it
// (Q7 a), "Libra falas", the "Të gjithë librat" grid and the author
// band; a filtered view is the grid alone. Rendered against a small
// in-memory double that evaluates the filters the page asks for.
// ============================================================
type Row = Record<string, unknown>;

// F5: makes the books LIST read fail (the Zgjedhja e Librum read, a
// maybeSingle, still works), to pin that a pick never shows over a
// failed load.
let failBookList = false;

function tableStub(rows: Row[]) {
  let result = [...rows];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, value: unknown) => ((result = result.filter((r) => r[col] === value)), builder),
    not: (col: string) => ((result = result.filter((r) => r[col] != null)), builder),
    // BD15 P8: array "contains" (categories) and the id re-fetch.
    contains: (col: string, values: unknown[]) =>
      ((result = result.filter((r) => values.every((v) => ((r[col] as unknown[]) ?? []).includes(v)))), builder),
    in: (col: string, values: unknown[]) => ((result = result.filter((r) => values.includes(r[col]))), builder),
    gte: (col: string, v: number) => ((result = result.filter((r) => (r[col] as number) >= v)), builder),
    lte: (col: string, v: number) => ((result = result.filter((r) => (r[col] as number) <= v)), builder),
    order: (col: string) =>
      ((result = [...result].sort((a, b) => String(b[col]).localeCompare(String(a[col])))), builder),
    limit: (n: number) => ((result = result.slice(0, n)), builder),
    returns: () => builder,
    // F5: getLibrumChoiceBook's single-row read.
    maybeSingle: () => Promise.resolve({ data: result[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) =>
      resolve(failBookList ? { data: null, error: { message: "boom" } } : { data: result, error: null }),
  };
  return builder;
}

function book(n: number, priceAll: number): Row {
  const day = String(n).padStart(2, "0");
  return {
    id: `book-${day}`, title: `Book ${day}`, author_id: "author", status: "published",
    price_all: priceAll, genre: "Letërsi artistike", categories: ["Letërsi artistike"], cover_path: null,
    description: `About ${day}.`,
    created_at: `2026-10-${day}T00:00:00Z`, pen: { id: "pen-an-author", name: "An Author" },
  };
}

// Ten books, newest = book-10; books 3 and 8 are free.
const BOOKS = Array.from({ length: 10 }, (_, i) => book(i + 1, i + 1 === 3 || i + 1 === 8 ? 0 : 199));
// F5: the rows the books table holds in a test (BOOKS unless a test adds
// a pick).
let bookRows: Row[] = BOOKS;

let signedInUser: { id: string } | null = null;
let rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
let bundleRows: Row[] = [];

describe("BookstorePage: redesign step 3 layout", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    signedInUser = null;
    bookRows = BOOKS;
    failBookList = false;
    mockCreateClient.mockReset();
    mockCreateClient.mockImplementation(() => ({
      auth: { getUser: () => Promise.resolve({ data: { user: signedInUser } }) },
      from: (table: string) =>
        tableStub(table === "public_books" ? bookRows : table === "public_bundles" ? bundleRows : []),
      // BD15 P8: search_books returns every published, priced title match;
      // the page must pass no genre to it (the category is applied in the
      // id re-fetch).
      rpc: (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        const term = String(args.search_term ?? "").toLowerCase();
        return Promise.resolve({
          data: bookRows
            .filter((r) => r.status === "published" && r.price_all != null)
            .filter((r) => String(r.title).toLowerCase().includes(term))
            .map((r) => ({ book_id: r.id })),
          error: null,
        });
      },
      storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/c.png" } }) }) },
    }));
    rpcCalls = [];
    bundleRows = [];
  });

  async function render(params: Record<string, string> = {}) {
    const element = await BookstorePage({ searchParams: Promise.resolve(params) });
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
  }

  // P2: the grid has no visible heading now; its section is labelled.
  function grid(html: string): string {
    const start = html.indexOf('aria-label="Të gjithë librat"');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</section>", start));
  }

  function section(html: string, heading: string): string {
    const start = html.indexOf(`>${heading}</h2>`);
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</section>", start));
  }

  // BD15 P8: a category matches any of a book's (up to 3) categories,
  // with or without a search term.
  function withSecondCategory(n: number, extra: Row = {}): Row[] {
    return BOOKS.map((b) =>
      b.id === `book-${String(n).padStart(2, "0")}`
        ? { ...b, categories: ["Letërsi artistike", "Fantazi"], ...extra }
        : b,
    );
  }

  it("BD15 P8: a category view lists a book whose SECOND category matches", async () => {
    bookRows = withSecondCategory(5);
    const html = await render({ genre: "Fantazi" });
    expect(html).toContain("Book 05");
    expect(html).not.toContain("Book 04");
  });

  it("BD15 P8: a search inside a category matches any category, and search_books gets no genre", async () => {
    bookRows = withSecondCategory(5);
    const html = await render({ genre: "Fantazi", q: "Book" });
    expect(html).toContain("Book 05");
    expect(html).not.toContain("Book 06");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].args.genre_filter).toBeNull();
  });

  it("BD15 P8: an 18+ book's card in the grid carries the 18+ tag; others don't", async () => {
    bookRows = withSecondCategory(5, { is_adult: true });
    const html = await render({ genre: "Fantazi" });
    expect(html).toContain("18+");
    const other = await render({ genre: "Letërsi artistike", q: "Book 04" });
    expect(other).toContain("Book 04");
    expect(other).not.toContain("18+");
  });

  it("BD15 P8: a bundle card says 18+ only when a published book in it is 18+", async () => {
    const bundle = (id: string, members: Row[]) => ({
      id, title: `Pako ${id}`, price_all: 299, status: "published", created_at: "2026-10-20T00:00:00Z",
      pen: { id: "pen-an-author", name: "An Author" }, bundle_books: members.map((books) => ({ books })),
    });
    bundleRows = [
      bundle("x", [{ cover_path: null, status: "published", is_adult: true }]),
      bundle("y", [{ cover_path: null, status: "draft", is_adult: true }, { cover_path: null, status: "published", is_adult: false }]),
    ];
    const paketat = section(await render(), "Paketat");
    const cardX = paketat.slice(paketat.indexOf("Pako x"), paketat.indexOf("Pako y"));
    const cardY = paketat.slice(paketat.indexOf("Pako y"));
    expect(cardX).toContain('aria-hidden="true">18+</span>');
    expect(cardY).not.toContain("18+");
  });

  // P2 (design B): the feature is a slim strip with one "Shikoni librin"
  // pill to the book page (which owns buying and the sample reader).
  it("features the newest book as a slim strip with its price and one link to the book", async () => {
    const html = await render();
    const feature = html.slice(0, html.indexOf("</section>"));
    expect(feature).toContain("I ri në Librum");
    expect(feature).toContain("Book 10");
    expect(feature).toContain("199 lekë");
    expect(feature).toMatch(/href="\/libra\/book-10"[^>]*>Shikoni librin</);
    expect(feature).not.toContain("Lexoni një pjesë");
    expect(feature).not.toContain("Blini ·");
  });

  // FIX1 (X6): Renato 17:11Z "5a" -- the second "I ri në Librum" shelf
  // after the featured book is removed; the featured block keeps the label.
  // F5 (C2, settled D7): a published, priced pick leads under "Librum's
  // choice"; otherwise the newest book stays "I ri në Librum".
  function withPick(n: number, extra: Row = {}): Row[] {
    return BOOKS.map((b) => (b.id === `book-${String(n).padStart(2, "0")}` ? { ...b, librum_choice_at: "2026-10-18T09:00:00Z", ...extra } : b));
  }
  const featureOf = (html: string) =>
    // P2: the strip is the page's first section.
    html.slice(0, html.indexOf("</section>"));

  it("features Zgjedhja e Librum when a published, priced book is picked", async () => {
    bookRows = withPick(4);
    const html = await render();
    const feature = featureOf(html);
    expect(feature).toContain("Zgjedhja e Librum");
    expect(feature).not.toContain("I ri në Librum");
    expect(feature).toContain("Book 04");
    expect(feature).toContain("199 lekë");
    expect(feature).toContain("An Author");
    expect(html).not.toContain("I ri në Librum");
    // The pick still appears in the grid in its normal place.
    expect(grid(html)).toContain("Book 04");
  });

  it("an unpriced pick falls back to the newest book as I ri në Librum", async () => {
    bookRows = withPick(4, { price_all: null });
    const feature = featureOf(await render());
    expect(feature).toContain("I ri në Librum");
    expect(feature).not.toContain("Zgjedhja e Librum");
    expect(feature).toContain("Book 10");
  });

  it("an unpublished pick falls back to the newest book as I ri në Librum", async () => {
    bookRows = withPick(4, { status: "draft" });
    const feature = featureOf(await render());
    expect(feature).toContain("I ri në Librum");
    expect(feature).toContain("Book 10");
  });

  it("a filtered view shows no feature block, pick or not", async () => {
    bookRows = withPick(4);
    const html = await render({ genre: "Letërsi artistike" });
    expect(html).not.toContain("featured-book-title");
    expect(html).not.toContain("Zgjedhja e Librum");
  });

  it("a failed book list shows no feature block, even with a pick", async () => {
    bookRows = withPick(4);
    failBookList = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render();
    quiet.mockRestore();
    expect(html).not.toContain("featured-book-title");
    expect(html).not.toContain("Zgjedhja e Librum");
  });

  it("has no second I ri në Librum shelf after the featured book", async () => {
    const html = await render();
    expect(html).not.toContain(">I ri në Librum</h2>");
    expect(html.match(/I ri në Librum/g)?.length).toBe(1);
  });

  it("shows free books under Libra falas, linking to the free filter", async () => {
    const shelf = section(await render(), "Libra falas");
    expect(shelf).toContain("Book 08");
    expect(shelf).toContain("Book 03");
    expect(shelf).not.toContain("Book 09");
    expect(shelf).toContain('href="/librari?maxPrice=0"');
  });

  // P2 (design B): "Libraria · N libra" heads the grid, after the strip.
  it("heads the grid with Libraria and its count after the strip, and ends with the author band", async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Libraria<span[^>]*> · 10 libra<\/span><\/h1>/);
    expect(html.indexOf("featured-book-title")).toBeLessThan(html.indexOf("<h1"));
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf('aria-label="Të gjithë librat"'));
    expect(grid(html)).toContain("Book 01");
    // The free shelf now follows the grid.
    expect(html.indexOf('aria-label="Të gjithë librat"')).toBeLessThan(html.indexOf(">Libra falas</h2>"));
    expect(html).toContain("Jeni autor?");
  });

  it("names the genre and the search words in the heading", async () => {
    const html = await render({ genre: "Letërsi artistike", q: "book" });
    expect(html).toMatch(/<h1[^>]*>Libraria<span[^>]*> · Letërsi artistike<\/span><span[^>]*> · “book”<\/span><span[^>]*> · 10 libra<\/span><\/h1>/);
  });

  it("has no big heading, page search box, page genre menu or ornate shelf any more", async () => {
    const html = await render();
    expect(html).not.toContain("Zbuloni libra të pavarur.");
    expect(html).not.toContain('id="bookstore-search"');
    expect(html).not.toContain('name="q"');
    expect(html).not.toContain('aria-label="Zhanret"');
    expect(html).not.toContain('aria-label="Librat më të rinj"');
  });

  // P2: the header's search box is the one search; on Libraria the page
  // gives it the current genre, sort and price (form="site-search"), never
  // the old words.
  it("adds the current genre, sort and price to the header search, not the words", async () => {
    const html = await render({ q: "book", genre: "Letërsi artistike", minPrice: "1", maxPrice: "500", sort: "price_asc" });
    for (const [name, value] of [["genre", "Letërsi artistike"], ["sort", "price_asc"], ["minPrice", "1"], ["maxPrice", "500"]]) {
      expect(html).toContain(`<input type="hidden" form="site-search" name="${name}" value="${value}"/>`);
    }
    expect(html).not.toMatch(/form="site-search" name="q"/);
    expect(await render()).not.toContain('form="site-search"');
  });

  it("the sort is its own form that keeps the words, genre and price", async () => {
    const html = await render({ q: "book", genre: "Letërsi artistike", minPrice: "1", maxPrice: "500", sort: "price_asc" });
    const start = html.lastIndexOf("<form", html.indexOf('id="bookstore-sort"'));
    const form = html.slice(start, html.indexOf("</form>", start));
    expect(form).toContain('action="/librari"');
    expect(form).toContain('<input type="hidden" name="q" value="book"/>');
    expect(form).toContain('<input type="hidden" name="genre" value="Letërsi artistike"/>');
    expect(form).toContain('<input type="hidden" name="minPrice" value="1"/>');
    expect(form).toContain('<input type="hidden" name="maxPrice" value="500"/>');
    expect(form).not.toContain('type="hidden" name="sort"');
    expect(form).toMatch(/<option value="price_asc" selected="">/);
    expect(form).toContain("<noscript>");
  });

  // FIX1 (X1): signed out -> sign up with Author chosen; signed in -> the
  // existing author entry route.
  it("Filloni të publikoni sends a signed-out visitor to sign up as an author", async () => {
    const html = await render();
    expect(html).toMatch(/href="\/signup\?role=author"[^>]*>Filloni të publikoni</);
    expect(html).not.toContain('href="/dashboard/books/new"');
  });

  it("Filloni të publikoni keeps the dashboard route for someone signed in", async () => {
    signedInUser = { id: "author" };
    const html = await render();
    expect(html).toMatch(/href="\/dashboard\/books\/new"[^>]*>Filloni të publikoni</);
  });

  it("a filtered view is the result grid alone: no feature, shelves or band", async () => {
    const html = await render({ genre: "Letërsi artistike" });
    expect(html).not.toContain("featured-book-title");
    expect(html).not.toContain(">I ri në Librum</h2>");
    expect(html).not.toContain(">Libra falas</h2>");
    expect(html).not.toContain("Jeni autor?");
    expect(html).toContain("10 libra");
    expect(html).toContain("Hiqni filtrat");
  });

  // P2: the genre menu moved to the site header
  // (src/components/header-bookstore-controls.tsx, tested in
  // src/lib/header-bookstore.test.ts).

  // BD15 follow-up (P8 audit N1): an unknown ?genre= is ignored, so the
  // page is the normal unfiltered Bookstore, never a load error.
  it("an unknown or malformed genre shows the normal page with every book", async () => {
    for (const genre of ["Horor", 'Poezi"}', "Poezi,Horror"]) {
      const html = await render({ genre });
      expect(html).toMatch(/<h1[^>]*>Libraria<span[^>]*> · 10 libra<\/span><\/h1>/);
      expect(html).toContain("Book 04");
      expect(html).toContain("featured-book-title");
      expect(html).not.toContain('name="genre"');
      expect(html).not.toContain(genre.replace(/"/g, "&quot;"));
    }
  });
});
