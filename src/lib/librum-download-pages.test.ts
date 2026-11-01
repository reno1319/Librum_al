import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { readLibrumPages } from "./librum-download-pages";

// BD3 + BD4 + BD4b: the details behind the two Librum pages. A small
// fake of the caller's session client: each table answers one canned result
// and records its filters. Invented names and example.com emails only.

const BOOK_ID = "9d8c7b6a-5f4e-4d3c-9b2a-1f0e9d8c7b6a";
const PEN_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const READER_ID = "c0ffee00-1234-4abc-9def-0123456789ab";
const ORIGIN = "https://librum.al";

type Result = { data: unknown; error: unknown };
type Call = { table: string; columns: string; filters: Array<[string, string, unknown]>; order?: unknown; limit?: number };

const BOOK_ROW = {
  id: BOOK_ID,
  title: "Lulja e marsit",
  subtitle: "Tregim",
  isbn: null,
  publisher: null,
  edition: null,
  original_publication_date: "2015-03-08",
  published_at: "2026-11-01T09:00:00Z",
  pen_name_id: PEN_ID,
  price_all: 299,
  pen: { id: PEN_ID, name: "Arben Prova" },
};

function fakeAdmin(over: Partial<Record<string, Result>> = {}) {
  const calls: Call[] = [];
  let booksCall = 0;
  const results = (table: string): Result => {
    if (table === "public_books") {
      booksCall += 1;
      return booksCall === 1
        ? over.book ?? { data: BOOK_ROW, error: null }
        : over.more ?? {
            data: [
              { id: "11111111-1111-4111-8111-111111111111", title: "Deti i dimrit" },
              { id: "22222222-2222-4222-8222-222222222222", title: "Rruga e gjatë" },
            ],
            error: null,
          };
    }
    if (table === "book_contributors") return over.translators ?? { data: [], error: null };
    if (table === "purchases")
      return over.purchase ?? { data: { id: "c0ffee00-1234-4abc-9def-0123456789ab", created_at: "2026-11-01T10:00:00Z", amount_cents: 199 }, error: null };
    throw new Error(`unexpected table ${table}`);
  };
  const from = (table: string) => {
    const call: Call = { table, columns: "", filters: [] };
    calls.push(call);
    const result = results(table);
    const builder = {
      select(columns: string) { call.columns = columns; return builder; },
      eq(c: string, v: unknown) { call.filters.push(["eq", c, v]); return builder; },
      neq(c: string, v: unknown) { call.filters.push(["neq", c, v]); return builder; },
      is(c: string, v: unknown) { call.filters.push(["is", c, v]); return builder; },
      not(c: string, op: string, v: unknown) { call.filters.push(["not", c, `${op} ${String(v)}`]); return builder; },
      order(c: string, o: unknown) { call.order = [c, o]; return builder; },
      limit(n: number) { call.limit = n; return builder; },
      maybeSingle: () => Promise.resolve(result),
      then: (resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  return { client: { from } as unknown as SupabaseClient, calls };
}

const BUYER = { readerId: READER_ID, email: "ana@example.com" };

describe("readLibrumPages", () => {
  it("a buyer: all details, © from the original year, Librum year from the first publish, buyer line from the purchase", async () => {
    const { client } = fakeAdmin();
    const pages = await readLibrumPages(client, { bookId: BOOK_ID, buyer: BUYER, siteOrigin: ORIGIN });
    expect(pages).not.toBeNull();
    expect(pages!.buyerLineMissing).toBe(false);
    expect(pages!.front).toEqual({
      title: "Lulja e marsit",
      subtitle: "Tregim",
      penName: "Arben Prova",
      copyrightYear: 2015,
      translators: [],
      librumYear: 2026,
      isbn: null,
      publisher: null,
      edition: null,
      buyer: { email: "ana@example.com", date: "1 nëntor 2026", code: "LB-C0FFEE00", free: false },
    });
    expect(pages!.last).toEqual({
      penName: "Arben Prova",
      books: [
        { title: "Deti i dimrit", url: `${ORIGIN}/libra/11111111-1111-4111-8111-111111111111` },
        { title: "Rruga e gjatë", url: `${ORIGIN}/libra/22222222-2222-4222-8222-222222222222` },
      ],
      reviewUrl: `${ORIGIN}/libra/${BOOK_ID}`,
    });
  });

  it("asks exactly the right rows: the public views, this pen name's other live priced books (max 5), the buyer's own unrefunded purchase", async () => {
    const { client, calls } = fakeAdmin();
    await readLibrumPages(client, { bookId: BOOK_ID, buyer: BUYER, siteOrigin: ORIGIN });
    expect(calls.map((c) => c.table).sort()).toEqual(["book_contributors", "public_books", "public_books", "purchases"]);
    expect(calls[0].columns).toContain("pen:public_pen_names(id, name)");
    expect(calls[0].filters).toEqual([["eq", "id", BOOK_ID]]);
    const more = calls.filter((c) => c.table === "public_books")[1];
    expect(more.filters).toEqual([
      ["eq", "pen_name_id", PEN_ID],
      ["eq", "status", "published"],
      ["not", "price_all", "is null"],
      ["neq", "id", BOOK_ID],
    ]);
    expect(more.order).toEqual(["created_at", { ascending: false }]);
    expect(more.limit).toBe(5);
    const purchase = calls.find((c) => c.table === "purchases")!;
    expect(purchase.filters).toEqual([
      ["eq", "book_id", BOOK_ID],
      ["eq", "reader_id", READER_ID],
      ["is", "refunded_at", null],
    ]);
    const tr = calls.find((c) => c.table === "book_contributors")!;
    expect(tr.filters).toEqual([["eq", "book_id", BOOK_ID], ["eq", "role", "Translator"]]);
  });

  it("the author's own download reads no purchase and has no buyer line", async () => {
    const { client, calls } = fakeAdmin();
    const pages = await readLibrumPages(client, { bookId: BOOK_ID, buyer: null, siteOrigin: ORIGIN });
    expect(pages!.front.buyer).toBeNull();
    expect(calls.some((c) => c.table === "purchases")).toBe(false);
  });

  it("no original date: © uses the year first published on Librum", async () => {
    const { client } = fakeAdmin({ book: { data: { ...BOOK_ROW, original_publication_date: null }, error: null } });
    const pages = await readLibrumPages(client, { bookId: BOOK_ID, buyer: null, siteOrigin: ORIGIN });
    expect(pages!.front.copyrightYear).toBe(2026);
  });

  it("never published yet (author's preview download): both years are this year, in Tirana", async () => {
    const { client } = fakeAdmin({ book: { data: { ...BOOK_ROW, original_publication_date: null, published_at: null }, error: null } });
    // 23:30 UTC on 31 Dec 2026 is already 2027 in Tirana.
    const pages = await readLibrumPages(client, { bookId: BOOK_ID, buyer: null, siteOrigin: ORIGIN, now: new Date("2026-12-31T23:30:00Z") });
    expect(pages!.front.librumYear).toBe(2027);
    expect(pages!.front.copyrightYear).toBe(2027);
  });

  it("a book first published late on 31 Dec UTC counts in Tirana's year", async () => {
    const { client } = fakeAdmin({ book: { data: { ...BOOK_ROW, published_at: "2026-12-31T23:30:00Z" }, error: null } });
    const pages = await readLibrumPages(client, { bookId: BOOK_ID, buyer: null, siteOrigin: ORIGIN });
    expect(pages!.front.librumYear).toBe(2027);
  });

  it("translators, ISBN, publisher and edition are passed through; blank values become null", async () => {
    const { client } = fakeAdmin({
      book: { data: { ...BOOK_ROW, isbn: "978-0-00-000000-0", publisher: "  ", edition: "Botimi i dytë" }, error: null },
      translators: { data: [{ name: "Drita Shembull" }, { name: " " }, { name: null }], error: null },
    });
    const pages = await readLibrumPages(client, { bookId: BOOK_ID, buyer: null, siteOrigin: ORIGIN });
    expect(pages!.front.translators).toEqual(["Drita Shembull"]);
    expect(pages!.front.isbn).toBe("978-0-00-000000-0");
    expect(pages!.front.publisher).toBeNull();
    expect(pages!.front.edition).toBe("Botimi i dytë");
  });

  // Audit r2 (N1): "free" comes from how this reader got the book.
  const PAID = { id: READER_ID, created_at: "2026-11-01T10:00:00Z", stripe_checkout_session_id: "cs_test", stripe_payment_intent_id: "pi_1" };
  it.each<[string, Record<string, unknown>, boolean]>([
    ["a free claim (free_ session, no payment intent)", { ...PAID, stripe_checkout_session_id: "free_1234", stripe_payment_intent_id: null }, true],
    ["a paid purchase", PAID, false],
    ["a paid book bought for 0 (bundle share, full discount): has a payment intent", { ...PAID, amount_cents: 0, stripe_checkout_session_id: null }, false],
    ["a free_ session but a payment intent (paid after a free claim)", { ...PAID, stripe_checkout_session_id: "free_1234" }, false],
    ["no session and no payment intent", { ...PAID, stripe_checkout_session_id: null, stripe_payment_intent_id: null }, false],
  ])("%s: free = %s", async (_label, purchase, free) => {
    const { client } = fakeAdmin({ purchase: { data: purchase, error: null } });
    const pages = await readLibrumPages(client, { bookId: BOOK_ID, buyer: BUYER, siteOrigin: ORIGIN });
    expect(pages!.front.buyer!.free).toBe(free);
  });

  it("a paid book made free later still says 'bought' to its earlier buyers", async () => {
    const { client } = fakeAdmin({ book: { data: { ...BOOK_ROW, price_all: 0 }, error: null }, purchase: { data: PAID, error: null } });
    const pages = await readLibrumPages(client, { bookId: BOOK_ID, buyer: BUYER, siteOrigin: ORIGIN });
    expect(pages!.front.buyer!.free).toBe(false);
  });

  // Audit r1: a missing purchase row drops only the buyer line.
  it.each<[string, Result]>([
    ["no purchase row", { data: null, error: null }],
    ["purchase read error", { data: { id: "p", created_at: "2026-11-01T10:00:00Z" }, error: { code: "x" } }],
    ["a row without a date", { data: { id: "p" }, error: null }],
  ])("%s: both pages stay, without the buyer line, flagged for the log", async (_label, purchase) => {
    const { client } = fakeAdmin({ purchase });
    const pages = await readLibrumPages(client, { bookId: BOOK_ID, buyer: BUYER, siteOrigin: ORIGIN });
    expect(pages).not.toBeNull();
    expect(pages!.front.buyer).toBeNull();
    expect(pages!.buyerLineMissing).toBe(true);
    expect(pages!.front.title).toBe("Lulja e marsit");
    expect(pages!.last.books).toHaveLength(2);
  });

  it("a failed translators or 'more books' read only drops that part", async () => {
    const { client } = fakeAdmin({
      translators: { data: null, error: { code: "x" } },
      more: { data: null, error: { code: "x" } },
    });
    const pages = await readLibrumPages(client, { bookId: BOOK_ID, buyer: null, siteOrigin: ORIGIN });
    expect(pages!.front.translators).toEqual([]);
    expect(pages!.last.books).toEqual([]);
  });

  it("this book is never listed in its own 'more books', even if returned", async () => {
    const { client } = fakeAdmin({ more: { data: [{ id: BOOK_ID, title: "Lulja e marsit" }], error: null } });
    const pages = await readLibrumPages(client, { bookId: BOOK_ID, buyer: null, siteOrigin: ORIGIN });
    expect(pages!.last.books).toEqual([]);
  });

  it.each<[string, Partial<Record<string, Result>>]>([
    ["book read error", { book: { data: BOOK_ROW, error: { code: "x" } } }],
    ["no book row", { book: { data: null, error: null } }],
    ["another book's row", { book: { data: { ...BOOK_ROW, id: "other" }, error: null } }],
    ["no pen name (a suspended account's pen name is hidden)", { book: { data: { ...BOOK_ROW, pen: null }, error: null } }],
    ["blank pen name", { book: { data: { ...BOOK_ROW, pen: { id: PEN_ID, name: "  " } }, error: null } }],
  ])("%s: null (the route serves the book without the pages)", async (_label, over) => {
    const { client } = fakeAdmin(over);
    expect(await readLibrumPages(client, { bookId: BOOK_ID, buyer: BUYER, siteOrigin: ORIGIN })).toBeNull();
  });
});
