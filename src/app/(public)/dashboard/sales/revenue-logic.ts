// LAUNCH-1 P1-8: pure, directly-testable revenue-filtering logic for
// the Sales dashboard, extracted the same way src/app/library/
// refund-logic.ts already separates pure logic from its page.tsx --
// page.tsx has no established Server Component test harness in this
// codebase (it's an async function using createClient()), so the
// actual filtering decision lives here instead, where it can be unit
// tested directly.

import { platformFeeCents } from "@/lib/pricing";
import {
  provenanceFromStoredCurrency,
  sumMinorUnitsByCurrency,
  type CurrencyProvenance,
  type CurrencyTotals,
  type TransactionCurrency,
} from "@/lib/transaction-money";

export type PaymentIntentBearing = {
  stripe_payment_intent_id: string | null;
};

// A lost-disputed purchase or bundle snapshot must not be represented
// as active author revenue -- refunded_at alone (already filtered by
// both of the Sales page's own queries) never covers this, since a
// dispute never sets refunded_at (see the P1-7A/P1-8 audits). A row
// with no payment intent at all (a free acquisition) can never match a
// dispute (a dispute always has a real payment intent) and is always
// kept. Used identically for both `purchases` rows and
// `bundle_checkout_snapshots` rows -- a bundle's purchases rows and its
// own snapshot row always share one payment intent, so filtering both
// arrays against the SAME lostDisputedPaymentIntentIds set (built once,
// from the union of both arrays' payment intent ids) excludes a
// disputed bundle transaction consistently across both
// representations, not just one.
export function excludeLostDisputedRows<T extends PaymentIntentBearing>(
  rows: T[],
  lostDisputedPaymentIntentIds: ReadonlySet<string>,
): T[] {
  return rows.filter(
    (row) =>
      row.stripe_payment_intent_id === null ||
      !lostDisputedPaymentIntentIds.has(row.stripe_payment_intent_id),
  );
}

// ---------------------------------------------------------------------
// ALL-TXN-CURRENCY-4 (Patch 4): currency-separated revenue.
//
// Every monetary figure on the Sales page is computed PER CURRENCY: the
// headline net revenue, each book's net revenue, and each day of the
// chart. A legacy USD sale and a new ALL sale are never added together,
// compared, or converted -- an author with both sees two totals and two
// series. A sale whose currency cannot be established is counted in
// `unresolvedCount` and left out of every money figure (it still counts
// as a unit, exactly as before -- units are books, not money).
//
// Unchanged by this patch, and kept here so they are testable:
//   * lost-disputed rows are excluded by the caller (excludeLostDisputedRows
//     above) before anything reaches this function;
//   * refunded rows are excluded by the caller's own queries;
//   * a bundle snapshot's total is added ONLY when no purchases row of
//     this author shares its Stripe Checkout Session
//     (selectTransactionOnlySnapshots below) -- otherwise its revenue is
//     already represented by those purchases rows and adding it again
//     would double-count it. That rule is unchanged; the snapshot's own
//     frozen currency now decides which currency its revenue lands in.
// ---------------------------------------------------------------------

export type SalesPurchase = {
  book_id: string;
  amount_cents: number;
  created_at: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  currency: CurrencyProvenance;
};

export type SalesBundleSnapshot = {
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  total_amount_cents: number | null;
  fulfilled_at: string;
  currency: string;
};

export type SalesBook = { id: string; title: string };

// The author's share of one sale, in the SAME minor units and currency
// it was given -- the platform fee is taken per sale, never across sales.
export function netMinorUnits(amountMinor: number): number {
  return amountMinor - platformFeeCents(amountMinor);
}

// The anti-double-counting rule, moved verbatim from the page: a
// snapshot qualifies as supplementary revenue only when its Stripe
// Checkout Session id is non-null and NOT among this author's purchases
// rows (the zero-eligible-item case: every bundle book was already
// owned, so fulfilment wrote no purchases row for that payment).
export function selectTransactionOnlySnapshots<S extends SalesBundleSnapshot>(
  purchases: SalesPurchase[],
  snapshots: S[],
): S[] {
  const purchasedSessionIds = new Set(purchases.map((p) => p.stripe_checkout_session_id));
  return snapshots.filter(
    (snapshot) =>
      snapshot.stripe_checkout_session_id !== null &&
      !purchasedSessionIds.has(snapshot.stripe_checkout_session_id),
  );
}

export type DailyNetSeries = {
  currency: TransactionCurrency;
  days: { date: Date; netMinor: number }[];
};

export type SalesRevenueSummary = {
  netTotals: CurrencyTotals;
  perBook: {
    id: string;
    title: string;
    unitsSold: number;
    net: CurrencyTotals;
  }[];
  // One series per currency with any resolved revenue, ordered by
  // currency code; every series has the same `chartDays` dates.
  dailySeries: DailyNetSeries[];
  chartDates: Date[];
};

function localDayStart(value: string | Date): Date {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function summarizeSalesRevenue(params: {
  books: SalesBook[];
  purchases: SalesPurchase[];
  transactionOnlySnapshots: SalesBundleSnapshot[];
  today: Date;
  chartDays: number;
}): SalesRevenueSummary {
  const { books, purchases, transactionOnlySnapshots, chartDays } = params;

  const revenueRows = [
    ...purchases.map((p) => ({
      bookId: p.book_id as string | null,
      at: p.created_at,
      netMinor: netMinorUnits(p.amount_cents),
      provenance: p.currency,
    })),
    // Bucketed by fulfilled_at (payment completion), exactly as before.
    ...transactionOnlySnapshots.map((s) => ({
      bookId: null as string | null,
      at: s.fulfilled_at,
      netMinor: netMinorUnits(s.total_amount_cents ?? 0),
      provenance: provenanceFromStoredCurrency(s.currency),
    })),
  ];

  const netTotals = sumMinorUnitsByCurrency(
    revenueRows.map((row) => ({ amountMinor: row.netMinor, provenance: row.provenance })),
  );

  const perBook = books
    .map((book) => {
      const bookPurchases = purchases.filter((p) => p.book_id === book.id);
      return {
        id: book.id,
        title: book.title,
        unitsSold: bookPurchases.length,
        net: sumMinorUnitsByCurrency(
          bookPurchases.map((p) => ({
            amountMinor: netMinorUnits(p.amount_cents),
            provenance: p.currency,
          })),
        ),
      };
    })
    // Money in different currencies cannot be ranked against each other,
    // so books are ordered by units sold, then title -- never by a
    // cross-currency revenue comparison.
    .sort((a, b) => b.unitsSold - a.unitsSold || a.title.localeCompare(b.title));

  const todayStart = localDayStart(params.today);
  const chartDates = Array.from({ length: chartDays }, (_, i) => {
    const date = new Date(todayStart);
    date.setDate(date.getDate() - (chartDays - 1 - i));
    return date;
  });

  const dailySeries: DailyNetSeries[] = netTotals.totals.map(({ currency }) => {
    const days = chartDates.map((date) => ({ date, netMinor: 0 }));
    for (const row of revenueRows) {
      if (row.provenance.state !== "resolved" || row.provenance.currency !== currency) continue;
      const rowDay = localDayStart(row.at).getTime();
      const bucket = days.find((d) => d.date.getTime() === rowDay);
      if (bucket) bucket.netMinor += row.netMinor;
    }
    return { currency, days };
  });

  return { netTotals, perBook, dailySeries, chartDates };
}
