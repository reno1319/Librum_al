import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// HOME-PICKS-1 (Renato 2026-10-25): the home hero is a fan of three
// covers -- the staff picks for slots 1-3, each empty or no-longer-live
// slot filled by the newest book not already shown -- with a Sponsored
// tag on paid slots only. Zgjedhja e Librum is not on the home page any
// more. "Botuar me Librum" skips the fan's books while enough
// others exist. Rendered against an in-memory books table that evaluates
// the filters the page asks for (public_books' own row filter is not
// modelled: the page asks for status = published itself).
type Row = Record<string, unknown>;
let rows: Row[] = [];
let slots: { slot: number; book_id: string; sponsored: boolean }[] = [];

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
vi.mock("@/lib/home-picks", () => ({ getPublicHomeSlots: () => Promise.resolve(slots) }));

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

// Link names in document order, split into the hero fan and the showcase.
// The fan draws slot 2, slot 1 (middle), slot 3.
async function fanAndShowcase() {
  const html = await render();
  const cut = html.indexOf(">Botuar me Librum</h2>");
  const names = (part: string) => [...part.matchAll(/aria-label="Shikoni (Book \d\d në Librum[^"]*)"/g)].map((m) => m[1].replace(" në Librum", ""));
  return { fan: names(cut === -1 ? html : html.slice(0, cut)), showcase: cut === -1 ? [] : names(html.slice(cut)) };
}

beforeEach(() => {
  rows = Array.from({ length: 9 }, (_, i) => book(i + 1));
  slots = [];
});

describe("home cover fan", () => {
  it("no slots filled: the three newest (newest in the middle), showcase = the next three", async () => {
    expect(await fanAndShowcase()).toEqual({
      fan: ["Book 08", "Book 09", "Book 07"],
      showcase: ["Book 06", "Book 05", "Book 04"],
    });
  });

  it("three picks, older than the newest list: exactly the picks; the showcase keeps the newest", async () => {
    slots = [
      { slot: 1, book_id: "book-01", sponsored: false },
      { slot: 2, book_id: "book-02", sponsored: false },
      { slot: 3, book_id: "book-03", sponsored: false },
    ];
    expect(await fanAndShowcase()).toEqual({
      fan: ["Book 02", "Book 01", "Book 03"],
      showcase: ["Book 09", "Book 08", "Book 07"],
    });
  });

  it("an empty slot falls back to the newest book not already shown", async () => {
    slots = [{ slot: 1, book_id: "book-09", sponsored: false }];
    expect((await fanAndShowcase()).fan).toEqual(["Book 08", "Book 09", "Book 07"]);
  });

  it.each([
    ["unpublished (draft: takedown, review and suspension too)", { status: "draft" }],
    ["without a price", { price_all: null }],
    ["without a cover", { cover_path: null }],
  ])("a pick %s falls back", async (_label, extra) => {
    rows[0] = book(1, extra);
    slots = [{ slot: 1, book_id: "book-01", sponsored: true }];
    const { fan } = await fanAndShowcase();
    expect(fan).toEqual(["Book 08", "Book 09", "Book 07"]);
    expect(fan.join()).not.toContain("sponsorizuar");
  });

  it("Sponsored shows only on a paid slot's cover, and the link says so", async () => {
    slots = [
      { slot: 1, book_id: "book-01", sponsored: true },
      { slot: 3, book_id: "book-03", sponsored: false },
    ];
    const html = await render();
    expect((await fanAndShowcase()).fan).toEqual(["Book 09", "Book 01 (sponsorizuar)", "Book 03"]);
    expect(html.match(/>Sponsorizuar</g)).toHaveLength(1);
  });

  it("Zgjedhja e Librum is not on the home page any more", async () => {
    rows[0] = book(1, { librum_choice_at: "2026-10-18T09:00:00Z" });
    const { fan, showcase } = await fanAndShowcase();
    expect([...fan, ...showcase]).not.toContain("Book 01");
  });

  it("fewer than three books in all: the photograph, no fan; the showcase shows them", async () => {
    rows = [book(1), book(2)];
    const html = await render();
    expect(html).toContain("/images/author-hero.jpg");
    expect(html).not.toContain('aria-label="Libra të zgjedhur"');
    expect((await fanAndShowcase()).showcase).toEqual(["Book 02", "Book 01"]);
  });

  it("only four books: the showcase tops up with fan books", async () => {
    rows = Array.from({ length: 4 }, (_, i) => book(i + 1));
    expect(await fanAndShowcase()).toEqual({
      fan: ["Book 03", "Book 04", "Book 02"],
      showcase: ["Book 01", "Book 04", "Book 03"],
    });
  });

  it("desktop sizing (option b): with the fan the hero splits 50/50 from xl and the covers fill the column; the photograph keeps 55/45", async () => {
    const html = await render();
    expect(html).toContain("lg:grid-cols-[55fr_45fr]");
    expect(html).toContain("xl:grid-cols-[1fr_1fr]");
    expect(html.match(/lg:w-\[42%\] lg:max-w-\[240px\]/g)).toHaveLength(1);
    expect(html.match(/lg:w-\[33%\] lg:max-w-\[190px\]/g)).toHaveLength(2);
    rows = [book(1), book(2)];
    const photo = await render();
    expect(photo).toContain("lg:grid-cols-[55fr_45fr]");
    expect(photo).not.toContain("xl:grid-cols-[1fr_1fr]");
  });

  it("the middle cover loads first; every cover is a real cover image with an empty alt", async () => {
    const html = await render();
    const fan = html.slice(0, html.indexOf(">Botuar me Librum</h2>"));
    expect(fan.match(/<img[^>]*src="https:\/\/cdn\.example\/c\/\d\d\.png"[^>]*alt=""/g)).toHaveLength(3);
    // The one high-priority cover image is the middle one (slot 1, the newest here).
    const high = fan.match(/<img[^>]*fetchPriority="high"[^>]*>/gi) ?? [];
    expect(high).toHaveLength(1);
    expect(high[0]).toContain('src="https://cdn.example/c/09.png"');
  });
});
