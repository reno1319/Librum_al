import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { PICK_BADGE_TEXT, rankNumberText, rankParts, readBookSalesRanks, topRankBadge } from "./book-rank";

const admin = (result: unknown) => ({ rpc: async () => result }) as unknown as SupabaseClient;

describe("readBookSalesRanks", () => {
  it("orders by sort_order and keeps only good rows", async () => {
    const rows = [
      { category: "Histori", sales_rank: 3, sort_order: 2 },
      { category: null, sales_rank: 14, sort_order: 0 },
      null,
      { category: "Poezi", sales_rank: 0, sort_order: 3 },
      { category: "Fantazi", sales_rank: 1.5, sort_order: 4 },
      { category: 7, sales_rank: 1, sort_order: 5 },
      { category: "Romancë", sales_rank: 1, sort_order: 1 },
    ];
    expect(await readBookSalesRanks(admin({ data: rows, error: null }), "b")).toEqual([
      { category: null, rank: 14 },
      { category: "Romancë", rank: 1 },
      { category: "Histori", rank: 3 },
    ]);
  });

  it("returns nothing on an error, a non-list or a throw", async () => {
    expect(await readBookSalesRanks(admin({ data: [{ category: null, sales_rank: 1, sort_order: 0 }], error: { message: "x" } }), "b")).toEqual([]);
    expect(await readBookSalesRanks(admin({ data: null, error: null }), "b")).toEqual([]);
    const throwing = { rpc: async () => { throw new Error("x"); } } as unknown as SupabaseClient;
    expect(await readBookSalesRanks(throwing, "b")).toEqual([]);
  });
});

describe("labels", () => {
  it("names all of Libraria 'Librari' and links each place", () => {
    expect(rankParts([{ category: null, rank: 2 }, { category: "Histori", rank: 5 }])).toEqual([
      { category: null, rank: 2, label: "Librari", href: "/librari" },
      { category: "Histori", rank: 5, label: "Histori", href: "/librari?genre=Histori" },
    ]);
    expect(rankNumberText(14)).toBe("Nr. 14");
    expect(PICK_BADGE_TEXT).toBe("Zgjedhja e Librum");
  });

  it("badge: first category at 1, else Libraria at 1, else none", () => {
    expect(topRankBadge([{ category: null, rank: 1 }, { category: "A", rank: 2 }, { category: "B", rank: 1 }, { category: "C", rank: 1 }])?.label).toBe("B");
    expect(topRankBadge([{ category: null, rank: 1 }, { category: "A", rank: 2 }])?.label).toBe("Librari");
    expect(topRankBadge([{ category: null, rank: 2 }, { category: "A", rank: 3 }])).toBeNull();
    expect(topRankBadge([])).toBeNull();
  });
});
