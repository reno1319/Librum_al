import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// HOME-PICKS-1 (Renato 2026-10-25): the home hero is a fan of three
// covers -- the staff picks for slots 1-3, each empty or no-longer-live
// slot filled by the newest book not already shown -- with a Sponsored
// tag on paid slots only. Zgjedhja e Librum is not on the home page any
// more. HOME-ROWS-1 (Renato 2026-11-12, one row 1a-6a): "Botuar me
// Librum" is one sliding row of the 15 newest books, fan books
// included. Rendered against an in-memory books table that evaluates
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

// Link names in document order, split into the hero fan and the row. The fan draws slot 2, slot 1 (middle), slot 3.
async function fanAndShowcase() {
  const html = await render();
  const cut = html.indexOf(">Botuar me Librum</h2>");
  const names = (part: string) => [...part.matchAll(/aria-label="Shikoni (Book \d\d në Librum[^"]*)"/g)].map((m) => m[1].replace(" në Librum", ""));
  const row = (id: string) => {
    const start = html.indexOf(`id="${id}"`);
    if (start === -1) return [];
    const part = html.slice(start, html.indexOf("</ul>", start));
    return [...part.matchAll(/href="\/libra\/book-(\d\d)"/g)].map((m) => `Book ${m[1]}`);
  };
  return {
    fan: names(cut === -1 ? html : html.slice(0, cut)),
    newest: row("home-row-newest"),
  };
}

const NEWEST_NINE = ["Book 09", "Book 08", "Book 07", "Book 06", "Book 05", "Book 04", "Book 03", "Book 02", "Book 01"];

beforeEach(() => {
  rows = Array.from({ length: 9 }, (_, i) => book(i + 1));
  slots = [];
  vi.unstubAllEnvs();
});

describe("home cover fan", () => {
  // BD15 P8: an 18+ book carries the 18+ tag (Q1 a). HOME-ROWS-1: the
  // cards show no blurb.
  it("BD15 P8: an 18+ book is tagged in the rows; no description is shown", async () => {
    rows = Array.from({ length: 9 }, (_, i) => (i + 1 === 6 ? book(6, { is_adult: true }) : book(i + 1)));
    const html = await render();
    const newest = html.slice(html.indexOf('id="home-row-newest"'));
    expect(newest.match(/aria-hidden="true">18\+<\/span>/g)?.length).toBe(1);
    expect(html).not.toContain("About ");
  });

  it("no slots filled: the three newest (newest in the middle); the row = all newest, fan books included", async () => {
    const { fan, newest } = await fanAndShowcase();
    expect(fan).toEqual(["Book 08", "Book 09", "Book 07"]);
    expect(newest).toEqual(NEWEST_NINE);
  });

  it("the row holds at most the 15 newest books, newest first; no row heading, one Libraria link", async () => {
    rows = Array.from({ length: 20 }, (_, i) => book(i + 1));
    const html = await render();
    const { newest } = await fanAndShowcase();
    expect(newest).toEqual(Array.from({ length: 15 }, (_, i) => `Book ${String(20 - i).padStart(2, "0")}`));
    expect(html).not.toContain("Të rejat");
    expect(html).not.toContain("Më të shiturit");
    expect(html).not.toContain("Shikoni të gjitha");
    expect(html).toContain("Shikoni librat e botuar");
  });

  it("prices only while buying is on", async () => {
    const rowsOf = (html: string) => html.slice(html.indexOf(">Botuar me Librum</h2>"));
    expect(rowsOf(await render())).not.toContain("199 lekë");
    vi.stubEnv("NEW_CHECKOUT_REGIME", "librum_ledger_v1");
    vi.stubEnv("LEDGER_PAYMENT_PROVIDER", "pok");
    expect(rowsOf(await render()).match(/199 lekë/g)?.length).toBe(9);
  });

  it("no live books: no Botuar me Librum section", async () => {
    rows = [];
    expect(await render()).not.toContain("Botuar me Librum");
  });

  it("three picks, older than the newest list: exactly the picks; the row keeps the newest", async () => {
    slots = [
      { slot: 1, book_id: "book-01", sponsored: false },
      { slot: 2, book_id: "book-02", sponsored: false },
      { slot: 3, book_id: "book-03", sponsored: false },
    ];
    const { fan, newest } = await fanAndShowcase();
    expect(fan).toEqual(["Book 02", "Book 01", "Book 03"]);
    expect(newest).toEqual(NEWEST_NINE);
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
    const { fan, newest } = await fanAndShowcase();
    // Book 01 (the oldest) gets no special place for being Librum's
    // choice: not in the fan, and last in the newest-first row.
    expect(fan).not.toContain("Book 01");
    expect(newest).toEqual(NEWEST_NINE);
  });

  it("fewer than three books in all: the photograph, no fan; the row shows them", async () => {
    rows = [book(1), book(2)];
    const html = await render();
    expect(html).toContain("/images/author-hero.jpg");
    expect(html).not.toContain('aria-label="Libra të zgjedhur"');
    expect((await fanAndShowcase()).newest).toEqual(["Book 02", "Book 01"]);
  });

  it("only four books: the row shows all four", async () => {
    rows = Array.from({ length: 4 }, (_, i) => book(i + 1));
    const { fan, newest } = await fanAndShowcase();
    expect(fan).toEqual(["Book 03", "Book 04", "Book 02"]);
    expect(newest).toEqual(["Book 04", "Book 03", "Book 02", "Book 01"]);
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
