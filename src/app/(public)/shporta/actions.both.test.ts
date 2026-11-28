import { beforeEach, describe, expect, it, vi } from "vitest";

// Amazon book page P5 (bp10 b): "Shto të dyja në shportë" adds this book
// and the other one with the same rules as "Shto në shportë", skips a
// book already owned or already in the cart, and opens the cart. A
// refusal opens this book's page with its reason.
class Redirect extends Error {
  constructor(public to: string) {
    super(`REDIRECT ${to}`);
  }
}
const revalidated: string[] = [];
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidated.push(p) }));
vi.mock("@/lib/recovery-guard", () => ({ redirectIfRecoverySessionActive: async () => {} }));

type B = { id: string; status: string; price_all: number | null; author_id?: string };
let user: { id: string } | null = { id: "reader-1" };
let books: Record<string, B> = {};
let owned = new Set<string>();
let inCart = new Set<string>();
let cartCount = 0;
let insertError: { code: string } | null = null;
const inserts: unknown[] = [];

function chain(table: string) {
  const eqs: Record<string, unknown> = {};
  const c: Record<string, unknown> = {
    select: () => c,
    eq: (k: string, v: unknown) => ((eqs[k] = v), c),
    is: () => c,
    insert: (row: unknown) => {
      inserts.push(row);
      return Promise.resolve({ error: insertError });
    },
    maybeSingle: () => {
      const id = String(eqs.id ?? eqs.book_id);
      if (table === "public_books") return Promise.resolve({ data: books[id] ?? null, error: null });
      if (table === "books") return Promise.resolve({ data: books[id]?.author_id === eqs.author_id ? { id } : null, error: null });
      if (table === "cart_items") return Promise.resolve({ data: inCart.has(id) ? { id: "row" } : null, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    then: (resolve: (v: unknown) => unknown) => resolve({ count: cartCount, data: null, error: null }),
  };
  return c;
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (t: string) => chain(t),
    rpc: async (_n: string, args: { target_book_id: string }) => ({ data: owned.has(args.target_book_id), error: null }),
  }),
}));

const { addBothToCart } = await import("./actions");

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "stayed";
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    throw e;
  }
}
const err = (bookId: string, msg: string) => `/libra/${bookId}?error=${encodeURIComponent(msg)}`;

describe("addBothToCart", () => {
  beforeEach(() => {
    user = { id: "reader-1" };
    books = {
      a: { id: "a", status: "published", price_all: 399, author_id: "author-a" },
      b: { id: "b", status: "published", price_all: 299, author_id: "author-b" },
    };
    owned = new Set();
    inCart = new Set();
    cartCount = 0;
    insertError = null;
    inserts.length = 0;
    revalidated.length = 0;
  });

  it("adds both books and opens the cart", async () => {
    expect(await outcome(addBothToCart("a", "b"))).toBe("/shporta");
    expect(inserts).toEqual([
      { reader_id: "reader-1", book_id: "a" },
      { reader_id: "reader-1", book_id: "b" },
    ]);
    expect(revalidated).toEqual(["/"]);
  });

  it("skips a book already owned or already in the cart", async () => {
    owned = new Set(["a"]);
    inCart = new Set(["b"]);
    expect(await outcome(addBothToCart("a", "b"))).toBe("/shporta");
    expect(inserts).toEqual([]);
  });

  it("signed out: log in first, then back to this book", async () => {
    user = null;
    expect(await outcome(addBothToCart("a", "b"))).toBe(`/login?next=${encodeURIComponent("/libra/a")}`);
  });

  it("refuses the other book when it is not live and paid, on this book's page, adding nothing", async () => {
    books.b = { id: "b", status: "preorder", price_all: 299 };
    expect(await outcome(addBothToCart("a", "b"))).toBe(err("a", "Ky libër nuk mund të shtohet në shportë."));
    books.b = { id: "b", status: "published", price_all: 0 };
    expect(await outcome(addBothToCart("a", "b"))).toBe(err("a", "Ky libër nuk mund të shtohet në shportë."));
    expect(inserts).toEqual([]);
  });

  it("refuses the reader's own book", async () => {
    user = { id: "author-b" };
    expect(await outcome(addBothToCart("a", "b"))).toBe(err("a", "Nuk mund ta blini ose ta dhuroni librin tuaj."));
    expect(inserts).toEqual([]);
  });

  it("refuses the same book twice", async () => {
    expect(await outcome(addBothToCart("a", "a"))).toBe(err("a", "Ky libër nuk mund të shtohet në shportë."));
  });

  it("a cart with room for only one: says it is full and adds nothing", async () => {
    cartCount = 49;
    expect(await outcome(addBothToCart("a", "b"))).toBe(err("a", "Shporta mban deri në 50 libra."));
    expect(inserts).toEqual([]);
  });

  it("a failed add says so; a row added a moment ago in another tab is fine", async () => {
    insertError = { code: "500" };
    expect(await outcome(addBothToCart("a", "b"))).toBe(err("a", "Nuk u shtua në shportë. Provoni përsëri."));
    insertError = { code: "23505" };
    expect(await outcome(addBothToCart("a", "b"))).toBe("/shporta");
  });
});
