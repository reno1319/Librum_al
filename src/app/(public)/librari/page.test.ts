import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GENRES } from "@/lib/genres";

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
// Patch C: makes only the sidebar count read (select "categories, ...") fail.
let failFacets = false;

function tableStub(rows: Row[]) {
  let result = [...rows];
  let isFacetRead = false;
  const builder: Record<string, unknown> = {
    select: (cols?: string) => ((isFacetRead = String(cols ?? "").startsWith("categories")), builder),
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
      resolve(failBookList || (failFacets && isFacetRead) ? { data: null, error: { message: "boom" } } : { data: result, error: null }),
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
    failFacets = false;
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

  // Patch B: the count line's text, or null when there is none.
  function countLine(html: string): string | null {
    const m = html.match(/aria-live="polite"><span[^>]*>([^<]*)<\/span><\/p>/);
    return m ? m[1] : null;
  }

  // Patch B: the filter chips, in order, as { label, href } (the href's
  // &amp; decoded).
  function chips(html: string): { label: string; href: string }[] {
    return [...html.matchAll(/<a [^>]*aria-label="Hiq filtrin [^"]*"[^>]*>/g)].map(([tag]) => ({
      href: tag.match(/href="([^"]*)"/)![1].replace(/&amp;/g, "&"),
      label: tag.match(/aria-label="Hiq filtrin ([^"]*)"/)![1].replace(/&amp;/g, "&"),
    }));
  }

  function paramsOf(href: string): Record<string, string> {
    return Object.fromEntries(new URL(href, "https://x.test").searchParams);
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

  // P2 (design B): the feature is a slim strip with one "Shiko librin"
  // pill to the book page (which owns buying and the sample reader).
  it("features the newest book as a slim strip with its price and one link to the book", async () => {
    const html = await render();
    const feature = html.slice(0, html.indexOf("</section>"));
    expect(feature).toContain("I ri në Librum");
    expect(feature).toContain("Book 10");
    expect(feature).toContain("199 lekë");
    expect(feature).toMatch(/href="\/libra\/book-10"[^>]*>Shiko librin</);
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

  // Patch B: a plain "Libraria" h1 heads the grid, after the strip; the
  // count sits in the box, in a polite live region.
  it("heads the grid with Libraria and its count after the strip, and ends with the author band", async () => {
    const html = await render();
    expect(html).toMatch(/<h1[^>]*>Libraria<\/h1>/);
    expect(countLine(html)).toBe("10 libra");
    expect(html.indexOf("featured-book-title")).toBeLessThan(html.indexOf("<h1"));
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf('aria-label="Të gjithë librat"'));
    expect(grid(html)).toContain("Book 01");
    // The free shelf now follows the grid.
    expect(html.indexOf('aria-label="Të gjithë librat"')).toBeLessThan(html.indexOf(">Libra falas</h2>"));
    expect(html).toContain("Jeni autor?");
  });

  // Patch B: the genre and the words left the h1; they are chips now.
  it("names the genre and the search words as chips, not in the heading", async () => {
    const html = await render({ genre: "Letërsi artistike", q: "book" });
    expect(html).toMatch(/<h1[^>]*>Libraria<\/h1>/);
    expect(chips(html).map((c) => c.label)).toEqual(["“book”", "Letërsi artistike"]);
    expect(countLine(html)).toBe("10 libra");
  });

  it("has no big heading or ornate shelf any more", async () => {
    const html = await render();
    expect(html).not.toContain("Zbuloni libra të pavarur.");
    expect(html).not.toContain('aria-label="Librat më të rinj"');
    expect(html).not.toContain('form="site-search"');
  });

  // P2c (Renato 11-10 option b): the old header is back on every page, so
  // the search box and the genre list are back inside Libraria.
  it("the page's own search box shows the words and keeps the genre, sort and price", async () => {
    const html = await render({ q: "book", genre: "Letërsi artistike", minPrice: "1", maxPrice: "500", sort: "price_asc" });
    const start = html.indexOf('<form id="bookstore-search"');
    expect(start).toBeGreaterThan(-1);
    const form = html.slice(start, html.indexOf("</form>", start));
    expect(form).toContain('action="/librari"');
    expect(form).toContain('role="search"');
    expect(form).toMatch(/<input id="bookstore-q" type="search"[^>]*name="q" value="book"\/>/);
    expect(form).toContain('<input type="hidden" name="genre" value="Letërsi artistike"/>');
    expect(form).toContain('<input type="hidden" name="sort" value="price_asc"/>');
    expect(form).toContain('<input type="hidden" name="minPrice" value="1"/>');
    expect(form).toContain('<input type="hidden" name="maxPrice" value="500"/>');
    expect(form).not.toContain('type="hidden" name="q"');
    const plain = await render();
    const p0 = plain.indexOf('<form id="bookstore-search"');
    expect(plain.slice(p0, plain.indexOf("</form>", p0))).not.toContain('type="hidden"');
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
    expect(countLine(html)).toBe("10 libra");
    expect(html).toMatch(/href="\/librari"[^>]*>Hiq të gjitha</);
    expect(html).not.toContain("Hiqni filtrat");
  });

  // BD15 follow-up (P8 audit N1): an unknown ?genre= is ignored, so the
  // page is the normal unfiltered Bookstore, never a load error.
  it("an unknown or malformed genre shows the normal page with every book", async () => {
    for (const genre of ["Horor", 'Poezi"}', "Poezi,Horror"]) {
      const html = await render({ genre });
      expect(html).toMatch(/<h1[^>]*>Libraria<\/h1>/);
      expect(countLine(html)).toBe("10 libra");
      expect(html).not.toContain("Filtrat:");
      expect(html).toContain("Book 04");
      expect(html).toContain("featured-book-title");
      expect(html).not.toContain('name="genre"');
      expect(html).not.toContain(genre.replace(/"/g, "&quot;"));
    }
  });

  // ============================================================
  // Patch B (Renato 11-13): the filter chips and the count line.
  // ============================================================
  it("Patch B: each chip removes only its own filter, and sort never gets a chip", async () => {
    const html = await render({ q: "book", genre: "Letërsi artistike", sort: "price_asc", minPrice: "100", maxPrice: "500" });
    const found = chips(html);
    expect(found.map((c) => c.label)).toEqual(["“book”", "Letërsi artistike", "Çmimi: 100–500 lekë"]);
    const all = { q: "book", genre: "Letërsi artistike", sort: "price_asc", minPrice: "100", maxPrice: "500" };
    const without = (...keys: string[]) =>
      Object.fromEntries(Object.entries(all).filter(([k]) => !keys.includes(k)));
    expect(paramsOf(found[0].href)).toEqual(without("q"));
    expect(paramsOf(found[1].href)).toEqual(without("genre"));
    expect(paramsOf(found[2].href)).toEqual(without("minPrice", "maxPrice"));
    expect(html).toMatch(/href="\/librari"[^>]*>Hiq të gjitha</);
  });

  it("Patch B: the price chip covers min only (Nga), max only (Deri), and min and max", async () => {
    expect(chips(await render({ minPrice: "200" })).map((c) => c.label)).toEqual(["Nga 200 lekë"]);
    expect(chips(await render({ maxPrice: "300" })).map((c) => c.label)).toEqual(["Deri 300 lekë"]);
    expect(chips(await render({ minPrice: "100", maxPrice: "300" })).map((c) => c.label)).toEqual(["Çmimi: 100–300 lekë"]);
  });

  it("Patch B: maxPrice=0 shows a Falas chip, not a price chip, and the chip clears it", async () => {
    const found = chips(await render({ maxPrice: "0", q: "book" }));
    expect(found.map((c) => c.label)).toEqual(["“book”", "Falas"]);
    expect(paramsOf(found[1].href)).toEqual({ q: "book" });
  });

  it("Patch B: a price the grid ignores (not a whole number) gets no chip", async () => {
    const html = await render({ minPrice: "abc" });
    expect(chips(html)).toEqual([]);
    expect(html).not.toContain("Filtrat:");
  });

  it("Patch B: a genre with & keeps its text in the chip and is encoded in the other chips' links", async () => {
    bookRows = BOOKS.map((b) => ({ ...b, categories: ["Biografi & kujtime"] }));
    const html = await render({ genre: "Biografi & kujtime", q: "book" });
    const found = chips(html);
    expect(found.map((c) => c.label)).toEqual(["“book”", "Biografi & kujtime"]);
    expect(found[0].href).toBe("/librari?genre=Biografi+%26+kujtime");
    expect(paramsOf(found[0].href)).toEqual({ genre: "Biografi & kujtime" });
  });

  it("Patch B: a long search word is cut inside its chip (truncate), never widening the box", async () => {
    const long = "a".repeat(120);
    const html = await render({ q: long });
    expect(html).toMatch(new RegExp(`aria-label="Hiq filtrin “${long}”"[^>]*max-w-full[^>]*><span class="[^"]*max-w-full[^"]*"><span class="min-w-0 truncate">“${long}”</span>`));
  });

  it("Patch B r2: a sort-only view has Hiq të gjitha but no chips and no Filtrat label", async () => {
    const html = await render({ sort: "price_asc" });
    expect(chips(html)).toEqual([]);
    expect(html).not.toContain("Filtrat:");
    expect(html).toMatch(/href="\/librari"[^>]*>Hiq të gjitha</);
  });

  it("Patch B r2: no Hiq të gjitha on the unfiltered page", async () => {
    expect(await render()).not.toContain("Hiq të gjitha");
  });

  it("Patch B r2: each chip and Hiq të gjitha has a 44px tap area around a 36px pill", async () => {
    const html = await render({ genre: "Letërsi artistike", maxPrice: "300" });
    const tags = [...html.matchAll(/<a [^>]*aria-label="Hiq filtrin [^"]*"[^>]*>/g)].map(([tag]) => tag);
    expect(tags).toHaveLength(2);
    for (const tag of tags) expect(tag).toMatch(/class="[^"]*\bmin-h-11\b/);
    const clearAll = html.match(/<a [^>]*>Hiq të gjitha</)![0];
    expect(clearAll).toContain('href="/librari"');
    expect(clearAll).toMatch(/class="[^"]*\bmin-h-11\b/);
    expect(html).toMatch(/<span class="[^"]*\bmin-h-9\b[^"]*bg-primary\/10/);
  });

  it("Patch B: no results shows 0 libra, the help line and Hiq filtrat", async () => {
    const html = await render({ q: "zzz-no-match" });
    expect(countLine(html)).toBe("0 libra");
    expect(html).toContain("Asnjë libër nuk përputhet me kërkimin tuaj.");
    expect(html).toContain("Provoni një fjalë tjetër, ose hiqni një filtër.");
    expect(html).toMatch(/href="\/librari"[^>]*>Hiq filtrat</);
  });

  it("Patch B: a failed load shows no count line, but the box still renders", async () => {
    failBookList = true;
    const html = await render();
    expect(countLine(html)).toBeNull();
    expect(html).not.toContain('aria-live="polite"');
    expect(html).toContain('id="bookstore-search"');
    expect(html).toContain("Libraria nuk u hap dot tani.");
  });

  it("Patch B: one book reads 1 libër; more than 48 reads Po shfaqen 48 librat e parë", async () => {
    bookRows = [book(1, 199)];
    expect(countLine(await render())).toBe("1 libër");
    bookRows = Array.from({ length: 50 }, (_, i) => ({ ...book(1, 199), id: `many-${i}`, title: `Many ${i}` }));
    expect(countLine(await render())).toBe("Po shfaqen 48 librat e parë");
  });

  // ============================================================
  // Patch C (Renato 11-13, version A): the Kolibër-style sidebar.
  // ============================================================
  // The desktop sidebar (the first "Filtrat" nav; the phone panel holds
  // the same lists).
  function sidebar(html: string): string {
    const start = html.indexOf('<nav aria-label="Filtrat"');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</nav>", start));
  }
  // A list's rows as { text, count, href, active }.
  function rows(nav: string, heading: string) {
    const start = nav.indexOf(`>${heading}</h2>`);
    expect(start).toBeGreaterThan(-1);
    const part = nav.slice(start, nav.indexOf("</section>", start));
    return [...part.matchAll(/<a ([^>]*)>(?:<span[^>]*>([^<]*)<\/span>(?:<span[^>]*>(\d+)<\/span>)?|([^<]*))<\/a>/g)].map((m) => ({
      text: (m[2] ?? m[4]).replace(/&amp;/g, "&"),
      count: m[3] == null ? null : Number(m[3]),
      href: m[1].match(/href="([^"]*)"/)![1].replace(/&amp;/g, "&"),
      active: m[1].includes('aria-current="true"'),
    }));
  }
  const PEN = (id: string, name: string) => ({ pen: { id, name } });
  // 10 books: 6 in Letërsi artistike, 4 in Horror (one also Poezi), 3
  // pen names, one hidden by the BD14 gate (pen null).
  function catalogue(): Row[] {
    return BOOKS.map((b, i) => ({
      ...b,
      categories: i < 6 ? ["Letërsi artistike"] : i === 9 ? ["Horror", "Poezi", "Horror"] : ["Horror"],
      price_all: [0, 150, 200, 201, 399, 400, 401, 500, 199, 250][i],
      ...(i < 5 ? PEN("pen-a", "Ana") : i < 9 ? PEN("pen-b", "Bora") : { pen: null }),
    }));
  }

  it("Patch C: the title row has the serif Libraria, the count, and Renditja with the sort", async () => {
    const html = await render();
    expect(html).toMatch(/<h1 class="font-serif[^"]*">Libraria<\/h1>/);
    expect(countLine(html)).toBe("10 libra");
    expect(html).toMatch(/<label for="bookstore-sort"[^>]*>Renditja<\/label>/);
    expect(html.indexOf("<h1")).toBeLessThan(html.indexOf('id="bookstore-sort"'));
    expect(html.indexOf('id="bookstore-sort"')).toBeLessThan(html.indexOf('id="bookstore-search"'));
  });

  it("Patch C: genre counts cover the whole catalogue, not the filtered result", async () => {
    bookRows = catalogue();
    const html = await render({ genre: "Horror", maxPrice: "200" });
    const genres = rows(sidebar(html), "Zhanri");
    expect(genres.map((g) => [g.text, g.count])).toEqual([
      ["Të gjitha", 10],
      ["Letërsi artistike", 6],
      ["Horror", 4],
      ["Poezi", 1],
    ]);
    expect(countLine(html)).toBe("1 libër");
  });

  it("Patch C: a book in 2 genres counts in both; a repeated or unknown category counts once or not at all", async () => {
    bookRows = catalogue().map((b, i) => (i === 0 ? { ...b, categories: ["Letërsi artistike", "Roman"] } : b));
    const genres = rows(sidebar(await render()), "Zhanri");
    expect(genres.find((g) => g.text === "Horror")!.count).toBe(4);
    expect(genres.find((g) => g.text === "Poezi")!.count).toBe(1);
    expect(genres.some((g) => g.text === "Roman")).toBe(false);
  });

  it("Patch C: only genres with books show, by count then name; the active genre shows even with 0", async () => {
    bookRows = catalogue();
    const plain = rows(sidebar(await render()), "Zhanri").map((g) => g.text);
    expect(plain).not.toContain("Fantazi");
    const html = await render({ genre: "Fantazi" });
    const genres = rows(sidebar(html), "Zhanri");
    expect(genres.at(-1)).toMatchObject({ text: "Fantazi", count: 0, active: true });
  });

  it("B2: Titulli A–Zh lists the grid in Albanian alphabet order, also after a search, and is offered in the sort", async () => {
    const titles = ["Zhurma", "Dhoma", "Ëndrra", "Çelësi", "Era", "Dritarja", "Cana", "Gjethi", "Guri", "Zogu"];
    bookRows = BOOKS.map((b, i) => ({ ...b, title: titles[i] }));
    const expected = ["Cana", "Çelësi", "Dritarja", "Dhoma", "Era", "Ëndrra", "Guri", "Gjethi", "Zogu", "Zhurma"];
    const order = (html: string) =>
      expected.map((t) => grid(html).indexOf(`>${t}<`)).every((pos, i, all) => pos > -1 && (i === 0 || all[i - 1] < pos));
    const html = await render({ sort: "title_asc" });
    expect(order(html)).toBe(true);
    expect(html).toContain('<option value="title_asc" selected="">Titulli A–Zh</option>');
    // After a search (the RPC path) the matches keep the same order.
    const searched = await render({ q: "a", sort: "title_asc" });
    const hits = expected.filter((t) => t.toLowerCase().includes("a"));
    const pos = hits.map((t) => grid(searched).indexOf(`>${t}<`));
    expect(pos.every((p, i) => p > -1 && (i === 0 || pos[i - 1] < p))).toBe(true);
  });

  it("Patch C: tapping the active genre clears it, keeping the words, sort and price", async () => {
    bookRows = catalogue();
    const html = await render({ q: "book", genre: "Horror", sort: "price_asc", maxPrice: "200" });
    const genres = rows(sidebar(html), "Zhanri");
    const horror = genres.find((g) => g.text === "Horror")!;
    expect(horror.active).toBe(true);
    expect(paramsOf(horror.href)).toEqual({ q: "book", sort: "price_asc", maxPrice: "200" });
    const poezi = genres.find((g) => g.text === "Poezi")!;
    expect(poezi.active).toBe(false);
    expect(paramsOf(poezi.href)).toEqual({ q: "book", genre: "Poezi", sort: "price_asc", maxPrice: "200" });
    expect(genres[0]).toMatchObject({ text: "Të gjitha", active: false });
    expect(paramsOf(genres[0].href)).toEqual({ q: "book", sort: "price_asc", maxPrice: "200" });
    expect(rows(sidebar(await render()), "Zhanri")[0].active).toBe(true);
  });

  it("Patch C: the price rows set their bounds; the active one is marked, clears itself and names the chip", async () => {
    const html = await render({ q: "book", minPrice: "200", maxPrice: "399" });
    const prices = rows(sidebar(html), "Çmimi");
    expect(prices.map((p) => p.text)).toEqual(["Falas", "Deri 199 lekë", "200–399 lekë", "400+ lekë"]);
    expect(prices.map((p) => p.active)).toEqual([false, false, true, false]);
    expect(paramsOf(prices[2].href)).toEqual({ q: "book" });
    expect(paramsOf(prices[0].href)).toEqual({ q: "book", maxPrice: "0" });
    expect(paramsOf(prices[1].href)).toEqual({ q: "book", minPrice: "1", maxPrice: "199" });
    expect(paramsOf(prices[3].href)).toEqual({ q: "book", minPrice: "400" });
    expect(chips(html).map((c) => c.label)).toEqual(["“book”", "200–399 lekë"]);
  });

  it("Patch C r2 (price a): every book is in exactly one price row; 199|200 and 399|400 split cleanly", async () => {
    bookRows = catalogue();
    const titles = async (params: Record<string, string>) =>
      [...grid(await render(params)).matchAll(/Book (\d\d)/g)].map((m) => Number(m[1])).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
    // prices by book: 1:0 2:150 3:200 4:201 5:399 6:400 7:401 8:500 9:199 10:250
    expect(await titles({ maxPrice: "0" })).toEqual([1]);
    expect(await titles({ minPrice: "1", maxPrice: "199" })).toEqual([2, 9]);
    expect(await titles({ minPrice: "200", maxPrice: "399" })).toEqual([3, 4, 5, 10]);
    expect(await titles({ minPrice: "400" })).toEqual([6, 7, 8]);
  });

  it("Patch C: a hand-typed range that is no preset marks no row, but its chip shows", async () => {
    const html = await render({ minPrice: "100", maxPrice: "300" });
    expect(rows(sidebar(html), "Çmimi").some((p) => p.active)).toBe(false);
    expect(chips(html).map((c) => c.label)).toEqual(["Çmimi: 100–300 lekë"]);
    // A lower bound of 0 filters nothing: 0–0 is Falas.
    expect(rows(sidebar(await render({ minPrice: "0", maxPrice: "0" })), "Çmimi")[0].active).toBe(true);
  });

  it("Patch C: authors are public pen names with their counts, linking to the author page; a hidden pen name never shows", async () => {
    bookRows = catalogue();
    const authors = rows(sidebar(await render()), "Autorë");
    expect(authors).toEqual([
      { text: "Ana", count: 5, href: "/autore/pen-a", active: false },
      { text: "Bora", count: 4, href: "/autore/pen-b", active: false },
    ]);
    expect(sidebar(await render())).not.toContain("Shiko të gjithë");
  });

  it("Patch C: the top 6 authors show; the rest open in place under Shiko të gjithë", async () => {
    bookRows = BOOKS.map((b, i) => ({ ...b, ...PEN(`pen-${i}`, `Autor ${String.fromCharCode(65 + i)}`), ...(i === 9 ? PEN("pen-0", "Autor A") : {}) }));
    const nav = sidebar(await render());
    const start = nav.indexOf(">Autorë</h2>");
    const part = nav.slice(start);
    const shown = part.slice(0, part.indexOf("<details"));
    const hidden = part.slice(part.indexOf("<details"), part.indexOf("</details>"));
    expect([...shown.matchAll(/>(Autor [A-Z])</g)].map((m) => m[1])).toEqual(["Autor A", "Autor B", "Autor C", "Autor D", "Autor E", "Autor F"]);
    // r2 (audit N4): the summary stays (focus stays on it) and reads
    // "Shiko më pak" once open; its group is named, so the open phone
    // Filtrat panel never hides it.
    expect(hidden).toMatch(/<details class="group\/authors"><summary[^>]*><span class="group-open\/authors:hidden">Shiko të gjithë<\/span><span class="hidden group-open\/authors:inline">Shiko më pak<\/span><\/summary>/);
    expect(hidden).not.toMatch(/class="[^"]*(?<![/\w-])group-open:hidden/);
    expect([...hidden.matchAll(/>(Autor [A-Z])</g)].map((m) => m[1])).toEqual(["Autor G", "Autor H", "Autor I"]);
    expect(hidden).not.toContain("href=\"#\"");
  });

  it("Patch C: a failed count read hides the counts and authors, keeps every genre and price row, and the grid", async () => {
    failFacets = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render();
    quiet.mockRestore();
    const nav = sidebar(html);
    const genres = rows(nav, "Zhanri");
    expect(genres.map((g) => g.text)).toEqual(["Të gjitha", ...GENRES]);
    expect(genres.every((g) => g.count == null)).toBe(true);
    expect(rows(nav, "Çmimi")).toHaveLength(4);
    expect(nav).not.toContain(">Autorë</h2>");
    expect(countLine(html)).toBe("10 libra");
    expect(grid(html)).toContain("Book 01");
  });

  it("Patch C: sidebar rows are 44px tap targets; the active row is cream and bold green", async () => {
    const html = await render({ genre: "Letërsi artistike" });
    const tags = [...sidebar(html).matchAll(/<a [^>]*>/g)].map(([t]) => t);
    expect(tags.length).toBeGreaterThan(5);
    for (const t of tags) expect(t).toMatch(/class="[^"]*\bmin-h-11\b/);
    const active = tags.filter((t) => t.includes('aria-current="true"'));
    expect(active).toHaveLength(1);
    expect(active[0]).toMatch(/bg-\[#f1eee6\] font-semibold text-primary/);
  });

  it("Patch C: phones get Filtrat (a details panel with the same lists) beside a 44px sort", async () => {
    const html = await render({ genre: "Horror" });
    expect(html).toMatch(/<details[^>]*><summary class="[^"]*\bh-11\b[^"]*">Filtrat<svg/);
    const navs = [...html.matchAll(/<nav aria-label="Filtrat"/g)];
    expect(navs).toHaveLength(2);
    const phone = html.slice(navs[1].index, html.indexOf("</nav>", navs[1].index));
    expect(rows(phone, "Zhanri").find((g) => g.text === "Horror")!.active).toBe(true);
    expect(html).toMatch(/id="bookstore-sort-phone"/);
    expect(html).toMatch(/<label for="bookstore-sort-phone" class="sr-only">Renditja<\/label>/);
  });

  it("Patch C: both sort forms keep the words, genre and price and have Rendit without JavaScript", async () => {
    const html = await render({ q: "book", genre: "Horror", minPrice: "1", maxPrice: "500", sort: "price_asc" });
    for (const id of ["bookstore-sort", "bookstore-sort-phone"]) {
      const at = html.indexOf(`id="${id}"`);
      const form = html.slice(html.lastIndexOf("<form", at), html.indexOf("</form>", at));
      expect(form).toContain('<input type="hidden" name="q" value="book"/>');
      expect(form).toContain('<input type="hidden" name="genre" value="Horror"/>');
      expect(form).toContain('<input type="hidden" name="minPrice" value="1"/>');
      expect(form).toContain('<input type="hidden" name="maxPrice" value="500"/>');
      expect(form).toMatch(/<option value="price_asc" selected="">/);
      expect(form).toMatch(/<noscript><button type="submit"[^>]*>Rendit<\/button><\/noscript>/);
    }
  });

  it("Patch C: one search box: a pill with a round Kërko button, 16px text, the formal label kept", async () => {
    const html = await render({ genre: "Horror" });
    expect(html.match(/id="bookstore-q"/g)).toHaveLength(1);
    expect(html).toContain('placeholder="Kërkoni libra, autorë…"');
    expect(html).toMatch(/<label for="bookstore-q" class="sr-only">Kërkoni libra ose autorë<\/label>/);
    expect(html).toMatch(/<input id="bookstore-q"[^>]*class="[^"]*\bh-11\b[^"]*\btext-base\b/);
    expect(html).toMatch(/<button type="submit" aria-label="Kërko"/);
    for (const old of [">Kërkoni<", ">Zbatoni<", ">Hiqni filtrat<", ">Renditni<", ">Zhanret<", ">Libra falas</a>"]) {
      expect(html).not.toContain(old);
    }
    const shelf = section(await render(), "Libra falas");
    expect(shelf).toMatch(/>Shiko të gjitha</);
  });

  it("Patch C: the grid shows 5 per row at xl and 4 at md, 2 on phones", async () => {
    expect(grid(await render())).toMatch(/<ul class="grid grid-cols-2 [^"]*md:grid-cols-4 xl:grid-cols-5">/);
  });

  // r2 (audit B1): the phone Filtrat panel closes when a filter is tapped.
  it("Patch C r2: the phone Filtrat panel closes on a link tap (closeOnLinkClick)", async () => {
    const element = await BookstorePage({ searchParams: Promise.resolve({ genre: "Horror" }) });
    const found: Record<string, unknown>[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node || typeof node !== "object" || !("props" in node)) return;
      const el = node as { type: unknown; props: Record<string, unknown> };
      if (typeof el.type === "function" && el.type.name === "DismissableDetails") found.push(el.props);
      walk(el.props.children);
    };
    walk(element);
    expect(found).toHaveLength(1);
    expect(found[0].closeOnLinkClick).toBe(true);
  });

  it("Patch C r2: the search button and the sort select are 44px tap targets", async () => {
    const html = await render();
    expect(html).toMatch(/<button type="submit" aria-label="Kërko" class="[^"]*\bsize-11\b[^"]*"><span class="[^"]*\bsize-9\b[^"]*bg-primary/);
    for (const id of ["bookstore-sort", "bookstore-sort-phone"]) {
      const sel = html.match(new RegExp(`<select[^>]*id="${id}"[^>]*>`))![0];
      expect(sel).toMatch(/class="[^"]*\bh-full\b[^"]*\bw-full\b/);
    }
    expect(html).toMatch(/<span class="relative flex h-11 [^"]*"><select/);
  });
});
