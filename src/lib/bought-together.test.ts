import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  ALSO_BOUGHT_CHIP,
  ALSO_BOUGHT_HEADING,
  BOUGHT_TOGETHER_HEADING,
  inIdOrder,
  pickTogetherBook,
  readBooksBoughtTogether,
  showAddBoth,
  togetherTotalLabel,
} from "./bought-together";

const admin = (result: unknown) => ({ rpc: async () => result }) as unknown as SupabaseClient;

describe("texts", () => {
  it("are his words (fb2 b, fb3 b)", () => {
    expect(BOUGHT_TOGETHER_HEADING).toBe("Blihen shpesh bashkë");
    expect(ALSO_BOUGHT_HEADING).toBe("Lexuesit blenë edhe");
    expect(ALSO_BOUGHT_CHIP).toBe("Blerë bashkë me këtë");
  });
});

describe("readBooksBoughtTogether", () => {
  it("orders by sort_order, keeps only good rows, never the book itself or a repeat", async () => {
    let called: unknown[] = [];
    const client = {
      rpc: async (...args: unknown[]) => {
        called = args;
        return {
          data: [
            { book_id: "c", sort_order: 3 },
            { book_id: "a", sort_order: 1 },
            null,
            { book_id: 7, sort_order: 2 },
            { book_id: "self", sort_order: 0 },
            { book_id: "b", sort_order: 2 },
            { book_id: "d", sort_order: 1.5 },
            { book_id: "a", sort_order: 4 },
          ],
          error: null,
        };
      },
    } as unknown as SupabaseClient;
    expect(await readBooksBoughtTogether(client, "self")).toEqual(["a", "b", "c"]);
    expect(called).toEqual(["books_bought_together", { p_book_id: "self" }]);
  });

  it("returns nothing on an error, a non-list or a throw", async () => {
    expect(await readBooksBoughtTogether(admin({ data: [{ book_id: "a", sort_order: 1 }], error: { message: "x" } }), "b")).toEqual([]);
    expect(await readBooksBoughtTogether(admin({ data: null, error: null }), "b")).toEqual([]);
    const throwing = { rpc: async () => { throw new Error("x"); } } as unknown as SupabaseClient;
    expect(await readBooksBoughtTogether(throwing, "b")).toEqual([]);
  });
});

describe("inIdOrder", () => {
  it("puts the books back in pair order and leaves out what the read left out", () => {
    const books = [{ id: "c" }, { id: "a" }];
    expect(inIdOrder(books, ["a", "b", "c"]).map((b) => b.id)).toEqual(["a", "c"]);
  });
});

describe("pickTogetherBook (bp9 b)", () => {
  it("takes the best real pair, else the first same-genre book, else none", () => {
    expect(pickTogetherBook([{ id: "r1" }, { id: "r2" }], [{ id: "g1" }], "x")?.id).toBe("r1");
    expect(pickTogetherBook([], [{ id: "g1" }, { id: "g2" }], "x")?.id).toBe("g1");
    expect(pickTogetherBook([], [], "x")).toBeNull();
    expect(pickTogetherBook([{ id: "x" }], [{ id: "x" }, { id: "g2" }], "x")?.id).toBe("g2");
  });
});

describe("togetherTotalLabel", () => {
  it("adds the two prices", () => {
    expect(togetherTotalLabel(399, 299)).toBe("698 lekë");
    expect(togetherTotalLabel(0, 299)).toBe("299 lekë");
    expect(togetherTotalLabel(0, 0)).toBe("Falas");
  });
  it("shows no total when a price is missing or not a valid price", () => {
    expect(togetherTotalLabel(null, 299)).toBeNull();
    expect(togetherTotalLabel(299, undefined)).toBeNull();
    expect(togetherTotalLabel(1, 299)).toBeNull();
  });
});

describe("showAddBoth (bp10 b)", () => {
  const both = [
    { status: "published", price_all: 399 },
    { status: "published", price_all: 299 },
  ];
  it("hidden while card payment is closed", () => {
    expect(showAddBoth({ paidCheckoutAvailable: false, purchaseState: "paid-unowned", books: both })).toBe(false);
    expect(showAddBoth({ paidCheckoutAvailable: false, purchaseState: "paid-unowned-checkout-closed", books: both })).toBe(false);
  });
  it("shown once it is open, for a reader who could buy this book (signed in or not)", () => {
    expect(showAddBoth({ paidCheckoutAvailable: true, purchaseState: "paid-unowned", books: both })).toBe(true);
    expect(showAddBoth({ paidCheckoutAvailable: true, purchaseState: "anonymous-paid", books: both })).toBe(true);
  });
  it("never for an owner, the author, a free book, or a book that is not live and paid", () => {
    for (const purchaseState of ["owned", "author", "free-unowned", "anonymous-free", "unavailable"]) {
      expect(showAddBoth({ paidCheckoutAvailable: true, purchaseState, books: both })).toBe(false);
    }
    expect(showAddBoth({ paidCheckoutAvailable: true, purchaseState: "paid-unowned", books: [both[0], { status: "published", price_all: 0 }] })).toBe(false);
    expect(showAddBoth({ paidCheckoutAvailable: true, purchaseState: "paid-unowned", books: [both[0], { status: "preorder", price_all: 299 }] })).toBe(false);
    expect(showAddBoth({ paidCheckoutAvailable: true, purchaseState: "paid-unowned", books: [both[0]] })).toBe(false);
  });
});
