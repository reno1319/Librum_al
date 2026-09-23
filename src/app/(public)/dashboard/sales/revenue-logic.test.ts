import { describe, expect, it } from "vitest";
import {
  excludeLostDisputedRows,
  selectTransactionOnlySnapshots,
  summarizeSalesRevenue,
  type SalesBundleSnapshot,
  type SalesPurchase,
} from "./revenue-logic";

describe("excludeLostDisputedRows", () => {
  it("excludes a row whose payment intent has a lost dispute", () => {
    const rows = [
      { stripe_payment_intent_id: "pi_clean" },
      { stripe_payment_intent_id: "pi_lost_disputed" },
    ];
    const result = excludeLostDisputedRows(rows, new Set(["pi_lost_disputed"]));
    expect(result).toEqual([{ stripe_payment_intent_id: "pi_clean" }]);
  });

  it("keeps a row with a null payment intent (a free acquisition) regardless of the excluded set", () => {
    const rows = [{ stripe_payment_intent_id: null }];
    const result = excludeLostDisputedRows(rows, new Set(["pi_anything"]));
    expect(result).toEqual(rows);
  });

  it("keeps every row unchanged when the excluded set is empty", () => {
    const rows = [{ stripe_payment_intent_id: "pi_a" }, { stripe_payment_intent_id: "pi_b" }];
    expect(excludeLostDisputedRows(rows, new Set())).toEqual(rows);
  });

  // LAUNCH-1 P1-8: a bundle's purchases rows and its own
  // bundle_checkout_snapshots row always share one payment intent --
  // calling this with the SAME excluded set against both arrays (as
  // the Sales page does) must exclude a disputed bundle transaction
  // consistently across both representations, not just one.
  it("excludes a disputed bundle transaction consistently across both purchases rows and its snapshot row", () => {
    const excluded = new Set(["pi_bundle_disputed"]);
    const purchases = [
      { stripe_payment_intent_id: "pi_bundle_disputed", book_id: "book-a" },
      { stripe_payment_intent_id: "pi_bundle_disputed", book_id: "book-b" },
      { stripe_payment_intent_id: "pi_clean", book_id: "book-c" },
    ];
    const snapshots = [
      { stripe_payment_intent_id: "pi_bundle_disputed", total_amount_cents: 999 },
      { stripe_payment_intent_id: "pi_clean_bundle", total_amount_cents: 500 },
    ];

    expect(excludeLostDisputedRows(purchases, excluded)).toEqual([
      { stripe_payment_intent_id: "pi_clean", book_id: "book-c" },
    ]);
    expect(excludeLostDisputedRows(snapshots, excluded)).toEqual([
      { stripe_payment_intent_id: "pi_clean_bundle", total_amount_cents: 500 },
    ]);
  });
});

// ALL-TXN-CURRENCY-4 (Patch 4): currency-separated revenue.
describe("summarizeSalesRevenue / selectTransactionOnlySnapshots (Patch 4)", () => {
  const TODAY = new Date(2026, 8, 23, 15, 0, 0);
  const USD = { state: "resolved", currency: "USD" } as const;
  const ALL = { state: "resolved", currency: "ALL" } as const;
  const BOOKS = [
    { id: "b1", title: "Alpha" },
    { id: "b2", title: "Beta" },
  ];

  function sale(overrides: Partial<SalesPurchase>): SalesPurchase {
    return {
      book_id: "b1",
      amount_cents: 1000,
      created_at: new Date(2026, 8, 23, 10, 0, 0).toISOString(),
      stripe_checkout_session_id: "cs_1",
      stripe_payment_intent_id: "pi_1",
      currency: USD,
      ...overrides,
    };
  }

  function snap(overrides: Partial<SalesBundleSnapshot>): SalesBundleSnapshot {
    return {
      stripe_checkout_session_id: "cs_snap",
      stripe_payment_intent_id: "pi_snap",
      total_amount_cents: 5000,
      fulfilled_at: new Date(2026, 8, 22, 10, 0, 0).toISOString(),
      currency: "ALL",
      ...overrides,
    };
  }

  function summarize(purchases: SalesPurchase[], snapshots: SalesBundleSnapshot[] = []) {
    return summarizeSalesRevenue({
      books: BOOKS,
      purchases,
      transactionOnlySnapshots: selectTransactionOnlySnapshots(purchases, snapshots),
      today: TODAY,
      chartDays: 14,
    });
  }

  it("net totals are separated by currency and never combined", () => {
    const summary = summarize([
      sale({ book_id: "b1", amount_cents: 1000, currency: USD, stripe_checkout_session_id: "cs_a" }),
      sale({ book_id: "b2", amount_cents: 9900, currency: ALL, stripe_checkout_session_id: "cs_b" }),
    ]);
    // 80% author share of each, per currency.
    expect(summary.netTotals).toEqual({
      totals: [
        { currency: "ALL", amountMinor: 7920 },
        { currency: "USD", amountMinor: 800 },
      ],
      unresolvedCount: 0,
    });
    // Negative control: the pre-Patch-4 single figure (800 + 7920).
    expect(summary.netTotals.totals.some((t) => t.amountMinor === 8720)).toBe(false);
  });

  it("each day of the chart is bucketed per currency -- one series per currency, never merged", () => {
    const summary = summarize([
      sale({ amount_cents: 1000, currency: USD, stripe_checkout_session_id: "cs_a" }),
      sale({ amount_cents: 9900, currency: ALL, stripe_checkout_session_id: "cs_b" }),
    ]);
    expect(summary.dailySeries.map((s) => s.currency)).toEqual(["ALL", "USD"]);
    const todayOf = (currency: string) =>
      summary.dailySeries.find((s) => s.currency === currency)!.days.at(-1)!.netMinor;
    expect(todayOf("ALL")).toBe(7920);
    expect(todayOf("USD")).toBe(800);
    for (const series of summary.dailySeries) {
      expect(series.days).toHaveLength(14);
      expect(series.days.some((d) => d.netMinor === 8720)).toBe(false);
    }
  });

  it("per-book revenue is kept per currency", () => {
    const summary = summarize([
      sale({ book_id: "b1", amount_cents: 1000, currency: USD, stripe_checkout_session_id: "cs_a" }),
      sale({ book_id: "b1", amount_cents: 9900, currency: ALL, stripe_checkout_session_id: "cs_b" }),
    ]);
    const alpha = summary.perBook.find((b) => b.id === "b1")!;
    expect(alpha.unitsSold).toBe(2);
    expect(alpha.net.totals).toEqual([
      { currency: "ALL", amountMinor: 7920 },
      { currency: "USD", amountMinor: 800 },
    ]);
  });

  it("a sale with an unknown currency counts as a unit but is excluded from every money figure", () => {
    const summary = summarize([
      sale({ amount_cents: 1000, currency: USD, stripe_checkout_session_id: "cs_a" }),
      sale({ amount_cents: 5000, currency: { state: "unknown" }, stripe_checkout_session_id: "cs_b" }),
    ]);
    expect(summary.netTotals).toEqual({ totals: [{ currency: "USD", amountMinor: 800 }], unresolvedCount: 1 });
    expect(summary.perBook.find((b) => b.id === "b1")!.unitsSold).toBe(2);
    expect(summary.dailySeries.map((s) => s.currency)).toEqual(["USD"]);
  });

  it("anti-double-counting is intact: a snapshot sharing a purchase's session is never added", () => {
    const purchases = [sale({ amount_cents: 1000, currency: ALL, stripe_checkout_session_id: "cs_bundle" })];
    const snapshots = [snap({ stripe_checkout_session_id: "cs_bundle", total_amount_cents: 1000, currency: "ALL" })];
    expect(selectTransactionOnlySnapshots(purchases, snapshots)).toEqual([]);
    expect(summarize(purchases, snapshots).netTotals.totals).toEqual([{ currency: "ALL", amountMinor: 800 }]);
  });

  it("a zero-eligible snapshot is added once, in its OWN frozen currency, never folded into another", () => {
    const purchases = [sale({ amount_cents: 1000, currency: USD, stripe_checkout_session_id: "cs_book" })];
    const snapshots = [snap({ stripe_checkout_session_id: "cs_only", total_amount_cents: 5000, currency: "ALL" })];
    const summary = summarize(purchases, snapshots);
    expect(summary.netTotals.totals).toEqual([
      { currency: "ALL", amountMinor: 4000 },
      { currency: "USD", amountMinor: 800 },
    ]);
    // It has no book: no per-book revenue, no unit.
    expect(summary.perBook.every((b) => b.net.totals.every((t) => t.currency === "USD"))).toBe(true);
    expect(summary.perBook.reduce((n, b) => n + b.unitsSold, 0)).toBe(1);
    // Bucketed on its fulfilment day, in the ALL series only.
    const all = summary.dailySeries.find((s) => s.currency === "ALL")!;
    expect(all.days.at(-2)!.netMinor).toBe(4000);
  });

  it("a snapshot with no Checkout Session id is never supplementary revenue (unchanged rule)", () => {
    const snapshots = [snap({ stripe_checkout_session_id: null })];
    expect(selectTransactionOnlySnapshots([], snapshots)).toEqual([]);
  });

  it("empty state: no totals, no series, and still 14 chart dates", () => {
    const summary = summarize([]);
    expect(summary.netTotals).toEqual({ totals: [], unresolvedCount: 0 });
    expect(summary.dailySeries).toEqual([]);
    expect(summary.chartDates).toHaveLength(14);
    expect(summary.perBook.map((b) => b.id)).toEqual(["b1", "b2"]);
  });

  it("single-currency state: one total, one series", () => {
    const summary = summarize([sale({ amount_cents: 9900, currency: ALL })]);
    expect(summary.netTotals.totals).toEqual([{ currency: "ALL", amountMinor: 7920 }]);
    expect(summary.dailySeries.map((s) => s.currency)).toEqual(["ALL"]);
  });

  it("books are ordered by units then title, never by a cross-currency revenue comparison", () => {
    const summary = summarize([
      sale({ book_id: "b2", amount_cents: 100, currency: USD, stripe_checkout_session_id: "cs_a" }),
      sale({ book_id: "b2", amount_cents: 100, currency: USD, stripe_checkout_session_id: "cs_b" }),
      sale({ book_id: "b1", amount_cents: 100000, currency: ALL, stripe_checkout_session_id: "cs_c" }),
    ]);
    expect(summary.perBook.map((b) => b.id)).toEqual(["b2", "b1"]);
  });
});
