import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// HOMEPAGE-2 (Renato 2026-11-19): the "Ti je botuesi yt!" row shows a
// fan of the five newest priced books with a cover (no free classics);
// with fewer than three it shows the photograph instead. The staff picks
// and the "Botuar me Librum" row are no longer on the home page.
// Rendered against an in-memory books table that evaluates the filters
// the page asks for.
type Row = Record<string, unknown>;
let rows: Row[] = [];

function booksTable() {
  let result = [...rows];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, value: unknown) =>
      ((result = result.filter((r) => (col === "is_adult" ? (r[col] ?? false) : r[col]) === value)), builder),
    not: (col: string) => ((result = result.filter((r) => r[col] != null)), builder),
    in: (col: string, values: unknown[]) => ((result = result.filter((r) => values.includes(r[col]))), builder),
    // K6: `.is("pd_work_id", null)` (the row leaves out the classics).
    is: (col: string, value: null) => ((result = result.filter((r) => (r[col] ?? null) === value)), builder),
    order: (col: string) =>
      ((result = [...result].sort((a, b) => String(b[col]).localeCompare(String(a[col])))), builder),
    limit: (n: number) => ((result = result.slice(0, n)), builder),
    returns: () => builder,
    then: (resolve: (v: unknown) => unknown) => resolve({ data: result, error: null }),
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
      from: (table: string) => {
        if (table !== "public_books") throw new Error(`unexpected table ${table}`);
        return booksTable();
      },
      storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example/${p}` } }) }) },
    }),
}));
// author-page-kit (Wave, Photo) loads its display fonts at import.
vi.mock("next/font/google", () => ({
  Playfair_Display: () => ({ className: "font-hero-letter" }),
  Ultra: () => ({ className: "font-hero-heavy" }),
  // HOMEPAGE-2 fonts: the homepage loads Lora + Inter itself.
  Lora: () => ({ style: { fontFamily: "Lora" } }),
  Inter: () => ({ style: { fontFamily: "Inter" } }),
}));

const { default: Home } = await import("./page");

function book(n: number, extra: Row = {}): Row {
  const day = String(n).padStart(2, "0");
  return {
    id: `book-${day}`, title: `Book ${day}`, status: "published", price_all: 199,
    genre: "Letërsi artistike", cover_path: `c/${day}.png`, description: `About ${day}.`, pen_name: null,
    created_at: `2026-10-${day}T00:00:00Z`, pen: { id: "pen-an-author", name: "An Author" }, ...extra,
  };
}

async function render() {
  const element = await Home({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

const fanCovers = (html: string) =>
  [...html.matchAll(/<img[^>]*src="https:\/\/cdn\.example\/c\/(\d\d)\.png"/g)].map((m) => `Book ${m[1]}`);

beforeEach(() => {
  rows = Array.from({ length: 9 }, (_, i) => book(i + 1));
});

describe("home cover fan (HOMEPAGE-2)", () => {
  it("shows the five newest books, newest first, as decorative images", async () => {
    const html = await render();
    expect(fanCovers(html)).toEqual(["Book 09", "Book 08", "Book 07", "Book 06", "Book 05"]);
    expect(html.match(/<img[^>]*src="https:\/\/cdn\.example[^>]*alt=""/g)).toHaveLength(5);
    // The hero art uses the photograph once; the fan replaces the second use.
    expect(html.match(/\/images\/author-hero\.jpg/g)).toHaveLength(1);
  });

  it.each([
    ["unpublished", { status: "draft" }],
    ["without a price", { price_all: null }],
    ["without a cover", { cover_path: null }],
    ["a free classic", { pd_work_id: "work-9" }],
    ["for adults (18+, hp2 a)", { is_adult: true }],
  ])("leaves out a book %s", async (_label, extra) => {
    rows[8] = book(9, extra);
    expect(fanCovers(await render())).toEqual(["Book 08", "Book 07", "Book 06", "Book 05", "Book 04"]);
  });

  it("fewer than three books: the photograph, no fan", async () => {
    rows = [book(1), book(2)];
    const html = await render();
    expect(fanCovers(html)).toEqual([]);
    expect(html.match(/\/images\/author-hero\.jpg/g)).toHaveLength(2);
  });

  it("no book row, staff picks or blurbs on the home page", async () => {
    const html = await render();
    expect(html).not.toContain("Botuar me Librum");
    expect(html).not.toContain("Sponsorizuar");
    expect(html).not.toContain("About ");
    expect(html).toContain("Ti je botuesi yt!");
  });
});
