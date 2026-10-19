import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// F5 (C3, Renato 10:17Z Q2 = b): Librum's choice is the first hero spine,
// followed by the newest other books; "Published with Librum" keeps its
// rule (books not on the shelf first, then shelf books, never twice,
// max 3) over that list. Rendered against an in-memory books table that
// evaluates the filters the page asks for.
type Row = Record<string, unknown>;
let rows: Row[] = [];

function booksTable() {
  let result = [...rows];
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, value: unknown) => ((result = result.filter((r) => r[col] === value)), builder),
    not: (col: string) => ((result = result.filter((r) => r[col] != null)), builder),
    in: (col: string, values: unknown[]) => ((result = result.filter((r) => values.includes(r[col]))), builder),
    order: (col: string) =>
      ((result = [...result].sort((a, b) => String(b[col]).localeCompare(String(a[col])))), builder),
    limit: (n: number) => ((result = result.slice(0, n)), builder),
    returns: () => builder,
    maybeSingle: () => Promise.resolve({ data: result[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: result, error: null }),
  };
  return builder;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: () =>
    Promise.resolve({
      auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
      from: () => booksTable(),
      storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example/${p}` } }) }) },
    }),
}));

const { default: Home } = await import("./page");

function book(n: number, extra: Row = {}): Row {
  const day = String(n).padStart(2, "0");
  return {
    id: `book-${day}`, title: `Book ${day}`, author_id: "author", status: "published", price_all: 199,
    genre: "Fiction", cover_path: `c/${day}.png`, description: `About ${day}.`, pen_name: null,
    created_at: `2026-10-${day}T00:00:00Z`, pen: { id: "pen-an-author", name: "An Author" }, ...extra,
  };
}
const PICKED = { librum_choice_at: "2026-10-18T09:00:00Z" };

async function render() {
  const element = await Home({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

// Titles in document order, split into the hero shelf and the showcase.
async function shelfAndShowcase() {
  const html = await render();
  const cut = html.indexOf(">Published with Librum</h2>");
  const titles = (part: string) => [...part.matchAll(/aria-label="View (Book \d\d) on Librum"/g)].map((m) => m[1]);
  return { shelf: titles(cut === -1 ? html : html.slice(0, cut)), showcase: cut === -1 ? [] : titles(html.slice(cut)) };
}

beforeEach(() => {
  rows = [];
});

describe("homepage hero with Librum's choice", () => {
  it("no pick: the 5 newest, showcase = the next 3 (today's behaviour)", async () => {
    rows = Array.from({ length: 9 }, (_, i) => book(i + 1));
    expect(await shelfAndShowcase()).toEqual({
      shelf: ["Book 09", "Book 08", "Book 07", "Book 06", "Book 05"],
      showcase: ["Book 04", "Book 03", "Book 02"],
    });
  });

  it("5 qualifying books + a pick: shelf = all 5 with the pick first; showcase = pick, newest, 2nd newest", async () => {
    rows = Array.from({ length: 5 }, (_, i) => book(i + 1, i === 2 ? PICKED : {}));
    expect(await shelfAndShowcase()).toEqual({
      shelf: ["Book 03", "Book 05", "Book 04", "Book 02", "Book 01"],
      showcase: ["Book 03", "Book 05", "Book 04"],
    });
  });

  it("6 qualifying books + a pick: the one book off the shelf first, then the pick and the newest", async () => {
    rows = Array.from({ length: 6 }, (_, i) => book(i + 1, i === 0 ? PICKED : {}));
    expect(await shelfAndShowcase()).toEqual({
      shelf: ["Book 01", "Book 06", "Book 05", "Book 04", "Book 03"],
      showcase: ["Book 02", "Book 01", "Book 06"],
    });
  });

  it("9 qualifying books, pick older than the 8 newest: pick + 4 newest, showcase = the 3 after the shelf", async () => {
    rows = Array.from({ length: 9 }, (_, i) => book(i + 1, i === 0 ? PICKED : {}));
    expect(await shelfAndShowcase()).toEqual({
      shelf: ["Book 01", "Book 09", "Book 08", "Book 07", "Book 06"],
      showcase: ["Book 05", "Book 04", "Book 03"],
    });
  });

  it("a pick among the 8 newest is not shown twice", async () => {
    rows = Array.from({ length: 9 }, (_, i) => book(i + 1, i === 6 ? PICKED : {}));
    const { shelf, showcase } = await shelfAndShowcase();
    expect(shelf).toEqual(["Book 07", "Book 09", "Book 08", "Book 06", "Book 05"]);
    expect(showcase).toEqual(["Book 04", "Book 03", "Book 02"]);
  });

  it.each([
    ["without a price", { price_all: null }],
    ["without a cover", { cover_path: null }],
  ])("a pick %s changes nothing", async (_label, extra) => {
    rows = [...Array.from({ length: 8 }, (_, i) => book(i + 2)), book(1, { ...PICKED, ...extra })];
    expect((await shelfAndShowcase()).shelf).toEqual(["Book 09", "Book 08", "Book 07", "Book 06", "Book 05"]);
  });

  it("fewer than 5 books in total with a pick: the photo, no shelf", async () => {
    rows = Array.from({ length: 4 }, (_, i) => book(i + 1, i === 0 ? PICKED : {}));
    const html = await render();
    expect(html).toContain("/images/author-hero.jpg");
    const { showcase } = await shelfAndShowcase();
    expect(showcase).toEqual(["Book 01", "Book 04", "Book 03"]);
  });

  it("the pick's spine carries its pen name when it has one", async () => {
    rows = Array.from({ length: 9 }, (_, i) => book(i + 1, i === 0 ? { ...PICKED, pen: { id: "pen-pena", name: "Pena" } } : {}));
    const html = await render();
    expect(html.slice(0, html.indexOf(">Published with Librum</h2>"))).toContain("Pena");
  });
});
