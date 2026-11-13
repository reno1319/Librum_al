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

  it("the genre list has every genre plus all genres, each keeping the words, sort and price", async () => {
    const html = await render({ q: "book", genre: "Letërsi artistike", sort: "price_asc", maxPrice: "500" });
    const start = html.indexOf('<nav aria-label="Zhanret"');
    expect(start).toBeGreaterThan(-1);
    const menu = html.slice(start, html.indexOf("</nav>", start));
    const links = [...menu.matchAll(/<a [^>]*>/g)];
    expect(links).toHaveLength(GENRES.length + 1);
    expect(menu).toContain(">Të gjitha zhanret</a>");
    expect(menu).toContain('href="/librari?q=book&amp;sort=price_asc&amp;maxPrice=500"');
    for (const g of GENRES) expect(menu).toContain(`>${g.replace("&", "&amp;")}</a>`);
    expect(menu).toMatch(/href="\/librari\?q=book&amp;genre=Poezi&amp;sort=price_asc&amp;maxPrice=500"/);
    expect(menu).toMatch(/aria-current="true"[^>]*>Letërsi artistike</);
    expect((menu.match(/aria-current/g) ?? []).length).toBe(1);
  });

  it("Libra falas is a pill to free books that keeps the words, genre and sort", async () => {
    const html = await render({ q: "book", genre: "Letërsi artistike", sort: "price_asc", minPrice: "100" });
    expect(html).toMatch(/href="\/librari\?q=book&amp;genre=Let%C3%ABrsi\+artistike&amp;sort=price_asc&amp;maxPrice=0"[^>]*>Libra falas<\/a>/);
    // P2d: when on, a tick icon comes before the words.
    expect(await render({ maxPrice: "0" })).toMatch(/aria-current="true"[^>]*><svg[^]*?<\/svg>Libra falas<\/a>/);
  });

  it("Libra falas switches off when tapped again, keeping the words, genre and sort (P2d)", async () => {
    const on = await render({ q: "book", genre: "Letërsi artistike", sort: "price_asc", maxPrice: "0" });
    expect(on).toMatch(/href="\/librari\?q=book&amp;genre=Let%C3%ABrsi\+artistike&amp;sort=price_asc"[^>]*><svg[^]*?<\/svg>Libra falas<\/a>/);
    expect(await render({ maxPrice: "0" })).toMatch(/href="\/librari"[^>]*><svg[^]*?<\/svg>Libra falas<\/a>/);
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

  it("Patch B: informal buttons on Libraria; the formal label and placeholder stay", async () => {
    const html = await render({ genre: "Letërsi artistike" });
    expect(html).toMatch(/<button type="submit"[^>]*>Kërko<\/button>/);
    expect(html).toMatch(/>Zbato<\/button>/);
    expect(html).toMatch(/<noscript><button type="submit"[^>]*>Rendit<\/button><\/noscript>/);
    expect(html).toContain('placeholder="Kërkoni libra ose autorë"');
    for (const old of [">Kërkoni<", ">Zbatoni<", ">Hiqni filtrat<", ">Shikoni të gjitha<", ">Shikoni librin<", ">Renditni<"]) {
      expect(html).not.toContain(old);
    }
    const shelf = section(await render(), "Libra falas");
    expect(shelf).toMatch(/>Shiko të gjitha</);
  });
});
