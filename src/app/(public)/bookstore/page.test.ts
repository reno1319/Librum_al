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
    expect(html).toContain("Scheduled maintenance");
    expect(html).toContain("temporarily unavailable for scheduled maintenance");
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
// under one label (Renato D1/D7), then "New on Librum" starting after it
// (Q7 a), "Free to start reading", the "All books" grid and the author
// band; a filtered view is the grid alone. Rendered against a small
// in-memory double that evaluates the filters the page asks for.
// ============================================================
type Row = Record<string, unknown>;

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
    then: (resolve: (v: unknown) => unknown) => resolve({ data: result, error: null }),
  };
  return builder;
}

function book(n: number, priceAll: number): Row {
  const day = String(n).padStart(2, "0");
  return {
    id: `book-${day}`, title: `Book ${day}`, author_id: "author", status: "published",
    price_all: priceAll, genre: "Fiction", cover_path: null, description: `About ${day}.`,
    created_at: `2026-10-${day}T00:00:00Z`, profiles: { public_author_name: "An Author" },
  };
}

// Ten books, newest = book-10; books 3 and 8 are free.
const BOOKS = Array.from({ length: 10 }, (_, i) => book(i + 1, i + 1 === 3 || i + 1 === 8 ? 0 : 199));

describe("BookstorePage: redesign step 3 layout", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockCreateClient.mockReset();
    mockCreateClient.mockImplementation(() => ({
      from: (table: string) => tableStub(table === "books" ? BOOKS : []),
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
    expect(feature).toContain("New on Librum");
    expect(feature).toContain("Book 10");
    expect(feature).toContain("199,00 ALL");
    expect(feature).toContain("Read sample");
    expect(feature).toContain(`Buy · 199,00 ALL`);
    expect(feature).toContain('href="/books/book-10"');
  });

  it("starts the New on Librum shelf after the featured book (Q7 a)", async () => {
    const shelf = section(await render(), "New on Librum");
    expect(shelf).not.toContain("Book 10");
    expect(shelf).toContain("Book 09");
    expect(shelf).toContain("Book 04");
    expect(shelf).not.toContain("Book 03");
    expect(shelf).toContain('href="#all-books"');
  });

  it("shows free books under Free to start reading, linking to the free filter", async () => {
    const shelf = section(await render(), "Free to start reading");
    expect(shelf).toContain("Book 08");
    expect(shelf).toContain("Book 03");
    expect(shelf).not.toContain("Book 09");
    expect(shelf).toContain('href="/bookstore?maxPrice=0"');
  });

  it("keeps the All books grid with its existing count line, and ends with the author band", async () => {
    const html = await render();
    const grid = section(html, "All books");
    expect(grid).toContain("10 books");
    expect(grid).toContain("Book 01");
    expect(html).toContain("Are you an author?");
    expect(html).toContain('href="/dashboard/books/new"');
  });

  it("a filtered view is the result grid alone: no feature, shelves, All books heading or band", async () => {
    const html = await render({ genre: "Fiction" });
    expect(html).not.toContain("featured-book-title");
    expect(html).not.toContain(">New on Librum</h2>");
    expect(html).not.toContain(">Free to start reading</h2>");
    expect(html).not.toContain(">All books</h2>");
    expect(html).not.toContain("Are you an author?");
    expect(html).toContain("10 books");
    expect(html).toContain("Clear filters");
  });

  it("marks the current genre in the genre menu", async () => {
    const html = await render({ genre: "Fiction" });
    expect(html).toMatch(/aria-current="true"[^>]*>Fiction</);
  });

  it("puts the genres behind one button that names the current genre", async () => {
    const all = await render({});
    expect(all).toMatch(/<summary[^>]*>All genres<svg/);
    expect(all).toMatch(/<nav aria-label="Genres"/);
    const fiction = await render({ genre: "Fiction" });
    expect(fiction).toMatch(/<summary[^>]*>Fiction<svg/);
  });
});
