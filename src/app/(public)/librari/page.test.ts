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
    price_all: priceAll, genre: "Letërsi artistike", cover_path: null, description: `About ${day}.`,
    created_at: `2026-10-${day}T00:00:00Z`, pen: { id: "pen-an-author", name: "An Author" },
  };
}

// Ten books, newest = book-10; books 3 and 8 are free.
const BOOKS = Array.from({ length: 10 }, (_, i) => book(i + 1, i + 1 === 3 || i + 1 === 8 ? 0 : 199));
// F5: the rows the books table holds in a test (BOOKS unless a test adds
// a pick).
let bookRows: Row[] = BOOKS;

let signedInUser: { id: string } | null = null;

describe("BookstorePage: redesign step 3 layout", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    signedInUser = null;
    bookRows = BOOKS;
    failBookList = false;
    mockCreateClient.mockReset();
    mockCreateClient.mockImplementation(() => ({
      auth: { getUser: () => Promise.resolve({ data: { user: signedInUser } }) },
      from: (table: string) => tableStub(table === "public_books" ? bookRows : []),
      storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/c.png" } }) }) },
    }));
  });

  async function render(params: Record<string, string> = {}) {
    const element = await BookstorePage({ searchParams: Promise.resolve(params) });
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
  }

  function section(html: string, heading: string): string {
    const start = html.indexOf(`>${heading}</h2>`);
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</section>", start));
  }

  it("features the newest book under the one label, with its Buy link and the sample reader", async () => {
    const html = await render();
    const feature = html.slice(html.indexOf("featured-book-title") - 200, html.indexOf("</section>"));
    expect(feature).toContain("I ri në Librum");
    expect(feature).toContain("Book 10");
    expect(feature).toContain("199 lekë");
    expect(feature).toContain("Lexoni një pjesë");
    expect(feature).toContain(`Blini · 199 lekë`);
    expect(feature).toContain('href="/libra/book-10"');
  });

  // FIX1 (X6): Renato 17:11Z "5a" -- the second "I ri në Librum" shelf
  // after the featured book is removed; the featured block keeps the label.
  // F5 (C2, settled D7): a published, priced pick leads under "Librum's
  // choice"; otherwise the newest book stays "I ri në Librum".
  function withPick(n: number, extra: Row = {}): Row[] {
    return BOOKS.map((b) => (b.id === `book-${String(n).padStart(2, "0")}` ? { ...b, librum_choice_at: "2026-10-18T09:00:00Z", ...extra } : b));
  }
  const featureOf = (html: string) =>
    html.slice(html.indexOf("featured-book-title") - 200, html.indexOf("</section>"));

  it("features Zgjedhja e Librum when a published, priced book is picked", async () => {
    bookRows = withPick(4);
    const html = await render();
    const feature = featureOf(html);
    expect(feature).toContain("Zgjedhja e Librum");
    expect(feature).not.toContain("I ri në Librum");
    expect(feature).toContain("Book 04");
    expect(feature).toContain("Blini · 199 lekë");
    expect(feature).toContain("An Author");
    expect(html).not.toContain("I ri në Librum");
    // The pick still appears in the Të gjithë librat grid in its normal place.
    expect(section(html, "Të gjithë librat")).toContain("Book 04");
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

  it("keeps the Të gjithë librat grid with its existing count line, and ends with the author band", async () => {
    const html = await render();
    const grid = section(html, "Të gjithë librat");
    expect(grid).toContain("10 libra");
    expect(grid).toContain("Book 01");
    expect(html).toContain("Jeni autor?");
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

  it("a filtered view is the result grid alone: no feature, shelves, Të gjithë librat heading or band", async () => {
    const html = await render({ genre: "Letërsi artistike" });
    expect(html).not.toContain("featured-book-title");
    expect(html).not.toContain(">I ri në Librum</h2>");
    expect(html).not.toContain(">Libra falas</h2>");
    expect(html).not.toContain(">Të gjithë librat</h2>");
    expect(html).not.toContain("Jeni autor?");
    expect(html).toContain("10 libra");
    expect(html).toContain("Hiqni filtrat");
  });

  it("marks the current genre in the genre menu", async () => {
    const html = await render({ genre: "Letërsi artistike" });
    expect(html).toMatch(/aria-current="true"[^>]*>Letërsi artistike</);
  });

  it("puts the genres behind one button that names the current genre", async () => {
    const all = await render({});
    expect(all).toMatch(/<summary[^>]*>Të gjitha zhanret<svg/);
    expect(all).toMatch(/<nav aria-label="Zhanret"/);
    const fiction = await render({ genre: "Letërsi artistike" });
    expect(fiction).toMatch(/<summary[^>]*>Letërsi artistike<svg/);
  });

  // BOOKSTORE ORNATE SHELF (Renato 10-25, header B; 1a/2a): the grid's
  // five newest books as ornate spines beside the heading, from 768px up,
  // and only on the unfiltered view.
  function ornateShelf(html: string): string {
    const start = html.indexOf('aria-label="Librat më të rinj"');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf("</ul>", start));
  }

  it("shows the five newest books as linked spines, newest first, with title and byline", async () => {
    const shelf = ornateShelf(await render());
    const ids = [...shelf.matchAll(/href="\/libra\/(book-\d+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["book-10", "book-09", "book-08", "book-07", "book-06"]);
    expect(shelf).toContain('aria-label="Shikoni Book 10 në Librum"');
    expect(shelf).toContain(">Book 10</span>");
    expect(shelf).toContain(">An Author</span>");
  });

  it("puts the search box under the heading and hides the shelf below 768px", async () => {
    const html = await render();
    expect(html.indexOf("Discover independent books.")).toBeLessThan(html.indexOf('id="bookstore-search"'));
    expect(html.indexOf('id="bookstore-search"')).toBeLessThan(html.indexOf('aria-label="Librat më të rinj"'));
    expect(html).toMatch(/class="hidden shrink-0 md:block \[zoom:0\.7\]"><div[^>]*><svg/);
  });

  it("has no ornate shelf on a filtered, sorted or price-limited view, or after a failed load", async () => {
    const views: Record<string, string>[] = [{ genre: "Letërsi artistike" }, { sort: "price_asc" }, { maxPrice: "0" }];
    for (const params of views) {
      expect(await render(params)).not.toContain('aria-label="Librat më të rinj"');
    }
    failBookList = true;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render();
    quiet.mockRestore();
    expect(html).not.toContain('aria-label="Librat më të rinj"');
  });

  it("an unpriced or draft book never reaches the shelf", async () => {
    bookRows = BOOKS.map((b) =>
      b.id === "book-10" ? { ...b, price_all: null } : b.id === "book-09" ? { ...b, status: "draft" } : b,
    );
    const shelf = ornateShelf(await render());
    expect(shelf).not.toContain("book-10");
    expect(shelf).not.toContain("book-09");
    expect([...shelf.matchAll(/href="\/libra\//g)]).toHaveLength(5);
  });
});
