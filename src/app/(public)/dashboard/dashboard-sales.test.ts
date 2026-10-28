import { describe, expect, it, vi } from "vitest";
import {
  formatMonthComparison,
  loadDashboardSales,
  summarizeDashboardSales,
} from "./dashboard-sales";
import type { SalesBundleSnapshot, SalesPurchase } from "./sales/revenue-logic";

const NOW = new Date(2026, 9, 17, 15, 0, 0); // 17 Oct 2026, server-local
const ALL = { state: "resolved", currency: "ALL" } as const;

function purchase(bookId: string, createdAt: Date, amount: number, extra: Partial<SalesPurchase> = {}): SalesPurchase {
  return {
    book_id: bookId,
    amount_cents: amount,
    created_at: createdAt.toISOString(),
    stripe_checkout_session_id: null,
    stripe_payment_intent_id: null,
    currency: ALL,
    ...extra,
  };
}

const BOOKS = [
  { id: "paid", price_all: 499 },
  { id: "free", price_all: 0 },
];

describe("summarizeDashboardSales", () => {
  it("counts paid-book copies as sales this month and last month; free downloads are not sales", () => {
    const summary = summarizeDashboardSales({
      books: BOOKS,
      purchases: [
        purchase("paid", new Date(2026, 9, 1, 0, 0, 1), 49900),
        purchase("paid", new Date(2026, 9, 16), 49900),
        purchase("free", new Date(2026, 9, 16), 0),
        purchase("paid", new Date(2026, 8, 30, 23, 59), 49900),
        purchase("paid", new Date(2026, 7, 31), 49900),
      ],
      transactionOnlySnapshots: [],
      now: NOW,
    });
    expect(summary.salesThisMonth).toBe(2);
    expect(summary.salesLastMonth).toBe(1);
  });

  it("net revenue this month and all time are summarizeSalesRevenue's netTotals for those rows", () => {
    const snapshot: SalesBundleSnapshot = {
      stripe_checkout_session_id: "cs_only",
      stripe_payment_intent_id: "pi_only",
      total_amount_cents: 100000,
      fulfilled_at: new Date(2026, 9, 2).toISOString(),
      currency: "ALL",
    };
    const summary = summarizeDashboardSales({
      books: BOOKS,
      purchases: [
        purchase("paid", new Date(2026, 9, 5), 49900),
        purchase("paid", new Date(2026, 8, 5), 49900),
      ],
      transactionOnlySnapshots: [snapshot],
      now: NOW,
    });
    const thisMonth = summary.netThisMonth.totals.find((t) => t.currency === "ALL")!.amountMinor;
    const allTime = summary.netAllTime.totals.find((t) => t.currency === "ALL")!.amountMinor;
    // The all-time total is this month's plus September's sale.
    expect(allTime).toBeGreaterThan(thisMonth);
    expect(thisMonth).toBeGreaterThan(0);
    // The snapshot adds money but never a sale.
    expect(summary.salesThisMonth).toBe(1);
  });

  it("keeps a sale with unknown currency out of money but in the count", () => {
    const summary = summarizeDashboardSales({
      books: BOOKS,
      purchases: [purchase("paid", new Date(2026, 9, 5), 49900, { currency: { state: "unknown" } })],
      transactionOnlySnapshots: [],
      now: NOW,
    });
    expect(summary.salesThisMonth).toBe(1);
    expect(summary.netThisMonth.totals).toEqual([]);
    expect(summary.netThisMonth.unresolvedCount).toBe(1);
  });

  it("counts every copy of each book in the last 30 days, paid and free", () => {
    const summary = summarizeDashboardSales({
      books: BOOKS,
      purchases: [
        purchase("paid", new Date(2026, 9, 10), 49900),
        purchase("paid", new Date(2026, 8, 20), 49900),
        purchase("paid", new Date(2026, 8, 10), 49900),
        purchase("free", new Date(2026, 9, 16), 0),
      ],
      transactionOnlySnapshots: [],
      now: NOW,
    });
    expect(summary.recentCopiesByBookId.get("paid")).toBe(2);
    expect(summary.recentCopiesByBookId.get("free")).toBe(1);
  });
});

describe("formatMonthComparison", () => {
  it("uses Renato's D1 wording", () => {
    expect(formatMonthComparison(23, 15)).toBe("+8 krahasuar me muajin e kaluar");
    expect(formatMonthComparison(3, 5)).toBe("−2 krahasuar me muajin e kaluar");
    expect(formatMonthComparison(4, 4)).toBe("Njëlloj si muajin e kaluar");
  });
});

// A minimal stand-in for the Supabase client: every query chain resolves
// to the result configured for its table, and rpc() to the result for
// its function name.
type Result = { data: unknown; error: unknown };
function fakeSupabase(tables: Record<string, Result>, rpcs: Record<string, Result>) {
  const chain = (result: Result) => {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "in", "is", "eq", "not", "order"]) {
      builder[method] = () => builder;
    }
    builder.returns = () => Promise.resolve(result);
    return builder;
  };
  return {
    from: vi.fn((table: string) => chain(tables[table] ?? { data: [], error: null })),
    rpc: vi.fn((name: string) => Promise.resolve(rpcs[name] ?? { data: [], error: null })),
  } as unknown as Parameters<typeof loadDashboardSales>[0]["supabase"];
}

// PEN-NAMES-2 [23b]: the author's sales come from author_book_purchases
// and author_bundle_sales (no buyer reader_id), not the base tables.
const OK_TABLES = {
  author_book_purchases: {
    data: [
      {
        id: "p1",
        book_id: "paid",
        amount_cents: 49900,
        created_at: new Date(2026, 9, 5).toISOString(),
        stripe_checkout_session_id: "cs_1",
        stripe_payment_intent_id: "pi_1",
      },
      {
        id: "p2",
        book_id: "paid",
        amount_cents: 49900,
        created_at: new Date(2026, 9, 6).toISOString(),
        stripe_checkout_session_id: "cs_2",
        stripe_payment_intent_id: "pi_lost",
      },
    ],
    error: null,
  },
  author_bundle_sales: { data: [], error: null },
};
const OK_RPCS = {
  author_lost_disputed_payment_intents: { data: [{ stripe_payment_intent_id: "pi_lost" }], error: null },
  list_purchase_currencies: {
    data: [
      { purchase_id: "p1", currency_state: "resolved", currency: "ALL" },
      { purchase_id: "p2", currency_state: "resolved", currency: "ALL" },
    ],
    error: null,
  },
};

describe("loadDashboardSales", () => {
  it("excludes lost-disputed purchases, as the Sales page does", async () => {
    const result = await loadDashboardSales({
      supabase: fakeSupabase(OK_TABLES, OK_RPCS),
      authorId: "author",
      books: BOOKS,
      now: NOW,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary.salesThisMonth).toBe(1);
  });

  const FAILURE = { data: null, error: { message: "boom" } };
  it.each([
    ["purchases read", { ...OK_TABLES, author_book_purchases: FAILURE }, OK_RPCS],
    ["snapshots read", { ...OK_TABLES, author_bundle_sales: FAILURE }, OK_RPCS],
    ["lost-dispute RPC", OK_TABLES, { ...OK_RPCS, author_lost_disputed_payment_intents: FAILURE }],
    ["currency RPC", OK_TABLES, { ...OK_RPCS, list_purchase_currencies: FAILURE }],
  ])("fails safe (ok: false, no figures) when the %s fails", async (_name, tables, rpcs) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await loadDashboardSales({
      supabase: fakeSupabase(tables, rpcs),
      authorId: "author",
      books: BOOKS,
      now: NOW,
    });
    expect(result).toEqual({ ok: false });
    spy.mockRestore();
  });
});
