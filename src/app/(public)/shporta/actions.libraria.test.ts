import { beforeEach, describe, expect, it, vi } from "vitest";

// LR1 (lr1-4 a): "Shto" on a Libraria card adds the book and keeps the
// reader on Libraria (no redirect on success); the book page's button
// still opens the cart. Both share every rule and refusal.
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

let user: { id: string } | null = { id: "reader-1" };
let book: { id: string; status: string; price_all: number | null } | null = { id: "b1", status: "published", price_all: 199 };
let owns = false;
let existing: { id: string } | null = null;
const inserts: unknown[] = [];

function chain(table: string) {
  const c: Record<string, unknown> = {
    select: () => c,
    eq: () => c,
    is: () => c,
    insert: (row: unknown) => {
      inserts.push(row);
      return Promise.resolve({ error: null });
    },
    maybeSingle: () =>
      Promise.resolve({ data: table === "public_books" ? book : table === "cart_items" ? existing : null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ count: 0, data: null, error: null }),
  };
  return c;
}
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user } }) },
    from: (t: string) => chain(t),
    rpc: async () => ({ data: owns, error: null }),
  }),
}));

const { addToCart, addToCartFromLibraria } = await import("./actions");

async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "stayed";
  } catch (e) {
    if (e instanceof Redirect) return e.to;
    throw e;
  }
}

describe("addToCartFromLibraria", () => {
  beforeEach(() => {
    user = { id: "reader-1" };
    book = { id: "b1", status: "published", price_all: 199 };
    owns = false;
    existing = null;
    inserts.length = 0;
    revalidated.length = 0;
  });

  it("adds the book and stays on the page, refreshing the header's cart number", async () => {
    expect(await outcome(addToCartFromLibraria("b1"))).toBe("stayed");
    expect(inserts).toEqual([{ reader_id: "reader-1", book_id: "b1" }]);
    expect(revalidated).toEqual(["/"]);
  });

  it("the book page's button still opens the cart", async () => {
    expect(await outcome(addToCart("b1"))).toBe("/shporta");
  });

  it("a visitor goes to log in and comes back to Libraria", async () => {
    user = null;
    expect(await outcome(addToCartFromLibraria("b1"))).toBe("/login?next=%2Flibrari");
    expect(inserts).toHaveLength(0);
  });

  it("a free book, or one the reader owns, opens the book page with the reason", async () => {
    book = { id: "b1", status: "published", price_all: 0 };
    expect(await outcome(addToCartFromLibraria("b1"))).toMatch(/^\/libra\/b1\?error=/);
    book = { id: "b1", status: "published", price_all: 199 };
    owns = true;
    expect(await outcome(addToCartFromLibraria("b1"))).toMatch(/^\/libra\/b1\?error=/);
    expect(inserts).toHaveLength(0);
  });

  it("already in the cart: no second row, still stays", async () => {
    existing = { id: "row-1" };
    expect(await outcome(addToCartFromLibraria("b1"))).toBe("stayed");
    expect(inserts).toHaveLength(0);
  });
});
