// REDESIGN STEP 4: the author dashboard's small money summary and each
// book's last-30-days figure. No new money maths: every net-revenue
// figure here comes from summarizeSalesRevenue() (the Sales page's own
// function), fed the same rows the Sales page reads -- refunded rows
// dropped by the query, lost-disputed rows dropped by
// excludeLostDisputedRows(), bundle snapshots added only through
// selectTransactionOnlySnapshots(). This file only chooses WHICH rows
// (this month, last month, last 30 days) and counts them.
//
// Counting rule: a purchases row is one copy of one book. A copy of a
// book whose current price is free counts as a download, every other
// copy as a sale (the book row says "sales" or "downloads" the same
// way). A transaction-only bundle snapshot is money with no book copy,
// so it adds to net revenue but never to a count -- exactly how the
// Sales page's "Units" treats it.
//
// Fail-safe rule: any failed read (purchases, snapshots, the lost-
// dispute RPC, the currency RPC) returns { ok: false } and the page
// shows "Could not load sales data. Please try again." in place of the
// figures. A failed read is never treated as "no sales", and it never
// takes the book list down with it.

import type { createClient } from "@/lib/supabase/server";
import { resolveCatalogPriceState } from "@/lib/catalog-price";
import { parseCurrencyProvenance, type CurrencyProvenance, type CurrencyTotals } from "@/lib/transaction-money";
import {
  excludeLostDisputedRows,
  selectTransactionOnlySnapshots,
  summarizeSalesRevenue,
  type SalesBundleSnapshot,
  type SalesPurchase,
} from "./sales/revenue-logic";
import type { Book } from "@/lib/types";

export const RECENT_SALES_DAYS = 30;

export type DashboardSalesBook = Pick<Book, "id" | "price_all">;

export type DashboardSalesSummary = {
  salesThisMonth: number;
  salesLastMonth: number;
  netThisMonth: CurrencyTotals;
  netAllTime: CurrencyTotals;
  // Copies in the last RECENT_SALES_DAYS days, by book id. Books with
  // none are absent (read as 0).
  recentCopiesByBookId: Map<string, number>;
};

export type DashboardSalesResult = { ok: true; summary: DashboardSalesSummary } | { ok: false };

// Server-local calendar months, the same clock summarizeSalesRevenue()
// already uses for the Sales page's daily chart.
function monthStart(now: Date, monthsBack: number): Date {
  return new Date(now.getFullYear(), now.getMonth() - monthsBack, 1);
}

function inRange(value: string, from: Date, to: Date | null): boolean {
  const time = new Date(value).getTime();
  return time >= from.getTime() && (to === null || time < to.getTime());
}

function netTotalsFor(purchases: SalesPurchase[], snapshots: SalesBundleSnapshot[]): CurrencyTotals {
  return summarizeSalesRevenue({
    books: [],
    purchases,
    transactionOnlySnapshots: snapshots,
    today: new Date(),
    // Totals only; the daily chart is the Sales page's job.
    chartDays: 0,
  }).netTotals;
}

export function summarizeDashboardSales(params: {
  books: DashboardSalesBook[];
  purchases: SalesPurchase[];
  transactionOnlySnapshots: SalesBundleSnapshot[];
  now: Date;
}): DashboardSalesSummary {
  const { books, purchases, transactionOnlySnapshots, now } = params;

  const freeBookIds = new Set(
    books.filter((book) => resolveCatalogPriceState(book.price_all) === "free").map((book) => book.id),
  );
  const isSale = (purchase: SalesPurchase) => !freeBookIds.has(purchase.book_id);

  const thisMonthStart = monthStart(now, 0);
  const lastMonthStart = monthStart(now, 1);
  const recentStart = new Date(now.getTime() - RECENT_SALES_DAYS * 24 * 60 * 60 * 1000);

  const thisMonthPurchases = purchases.filter((p) => inRange(p.created_at, thisMonthStart, null));
  const thisMonthSnapshots = transactionOnlySnapshots.filter((s) =>
    inRange(s.fulfilled_at, thisMonthStart, null),
  );

  const recentCopiesByBookId = new Map<string, number>();
  for (const purchase of purchases) {
    if (!inRange(purchase.created_at, recentStart, null)) continue;
    recentCopiesByBookId.set(purchase.book_id, (recentCopiesByBookId.get(purchase.book_id) ?? 0) + 1);
  }

  return {
    salesThisMonth: thisMonthPurchases.filter(isSale).length,
    salesLastMonth: purchases.filter(
      (p) => isSale(p) && inRange(p.created_at, lastMonthStart, thisMonthStart),
    ).length,
    netThisMonth: netTotalsFor(thisMonthPurchases, thisMonthSnapshots),
    netAllTime: netTotalsFor(purchases, transactionOnlySnapshots),
    recentCopiesByBookId,
  };
}

// "+8 krahasuar me muajin e kaluar" / "−2 …" / "Njëlloj si muajin e kaluar"
// (Renato's D1 wording, ALBANIAN-8). The minus is U+2212, as in the brief.
export function formatMonthComparison(thisMonth: number, lastMonth: number): string {
  const difference = thisMonth - lastMonth;
  if (difference === 0) return "Njëlloj si muajin e kaluar";
  return difference > 0
    ? `+${difference} krahasuar me muajin e kaluar`
    : `−${-difference} krahasuar me muajin e kaluar`;
}

type PurchaseRow = Omit<SalesPurchase, "currency"> & { id: string };

type PurchaseCurrencyRow = {
  purchase_id: string;
  currency_state: string;
  currency: string | null;
};

// The Sales page's own reads (src/app/(public)/dashboard/sales/page.tsx),
// with one difference: an error on ANY read fails the whole summary,
// where the Sales page treats a failed purchases/snapshots read as empty.
export async function loadDashboardSales(params: {
  supabase: Awaited<ReturnType<typeof createClient>>;
  authorId: string;
  books: DashboardSalesBook[];
  now: Date;
}): Promise<DashboardSalesResult> {
  const { supabase, authorId, books, now } = params;
  const bookIds = books.map((book) => book.id);

  let purchaseRows: PurchaseRow[] = [];
  if (bookIds.length > 0) {
    // PEN-NAMES-2 [23b]: purchases of the author's own books, without the
    // buyer's reader_id.
    const { data, error } = await supabase
      .from("author_book_purchases")
      .select(
        "id, book_id, amount_cents, created_at, stripe_checkout_session_id, stripe_payment_intent_id",
      )
      .in("book_id", bookIds)
      .is("refunded_at", null)
      .returns<PurchaseRow[]>();
    if (error) {
      console.error("DashboardPage: purchases read failed", { authorId, error });
      return { ok: false };
    }
    purchaseRows = data ?? [];
  }

  // PEN-NAMES-2 [23b]: the author's own fulfilled bundle sales, without
  // the buyer's reader_id.
  const { data: snapshotRows, error: snapshotError } = await supabase
    .from("author_bundle_sales")
    .select(
      "stripe_checkout_session_id, stripe_payment_intent_id, total_amount_cents, fulfilled_at, currency",
    )
    .eq("author_id", authorId)
    .not("fulfilled_at", "is", null)
    .is("refunded_at", null)
    .returns<SalesBundleSnapshot[]>();
  if (snapshotError) {
    console.error("DashboardPage: bundle_checkout_snapshots read failed", {
      authorId,
      error: snapshotError,
    });
    return { ok: false };
  }

  const { data: lostDisputed, error: lostDisputedError } = await supabase.rpc(
    "author_lost_disputed_payment_intents",
  );
  if (lostDisputedError) {
    console.error("DashboardPage: author_lost_disputed_payment_intents RPC failed", {
      authorId,
      error: lostDisputedError,
    });
    return { ok: false };
  }
  const lostDisputedPaymentIntentIds = new Set(
    ((lostDisputed ?? []) as { stripe_payment_intent_id: string }[]).map(
      (row) => row.stripe_payment_intent_id,
    ),
  );

  const currencyByPurchaseId = new Map<string, CurrencyProvenance>();
  if (purchaseRows.length > 0) {
    const { data: currencyRows, error: currencyError } = await supabase.rpc(
      "list_purchase_currencies",
      { p_purchase_ids: purchaseRows.map((purchase) => purchase.id) },
    );
    if (currencyError) {
      console.error("DashboardPage: list_purchase_currencies RPC failed", {
        authorId,
        error: currencyError,
      });
      return { ok: false };
    }
    for (const row of (currencyRows ?? []) as PurchaseCurrencyRow[]) {
      currencyByPurchaseId.set(row.purchase_id, parseCurrencyProvenance(row.currency_state, row.currency));
    }
  }

  const purchases = excludeLostDisputedRows(
    purchaseRows.map((purchase) => ({
      ...purchase,
      currency: currencyByPurchaseId.get(purchase.id) ?? ({ state: "unknown" } as const),
    })),
    lostDisputedPaymentIntentIds,
  );
  const snapshots = excludeLostDisputedRows(snapshotRows ?? [], lostDisputedPaymentIntentIds);

  return {
    ok: true,
    summary: summarizeDashboardSales({
      books,
      purchases,
      transactionOnlySnapshots: selectTransactionOnlySnapshots(purchases, snapshots),
      now,
    }),
  };
}
