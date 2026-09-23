import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  excludeLostDisputedRows,
  selectTransactionOnlySnapshots,
  summarizeSalesRevenue,
  type SalesPurchase,
  type SalesBundleSnapshot,
} from "./revenue-logic";
import {
  formatTransactionMinorUnits,
  parseCurrencyProvenance,
  type CurrencyProvenance,
  type CurrencyTotals,
} from "@/lib/transaction-money";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import type { Book } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sales",
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see V3 §3.
export const dynamic = "force-dynamic";

const CHART_DAYS = 14;

type PurchaseRow = {
  id: string;
  book_id: string;
  amount_cents: number;
  created_at: string;
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
};

type PurchaseCurrencyRow = {
  purchase_id: string;
  currency_state: string;
  currency: string | null;
};

// A fulfilled, non-refunded bundle snapshot whose Stripe Checkout Session
// isn't represented by any of this author's own purchases rows -- i.e. a
// snapshot bundle payment where every item turned out to already be
// actively owned through some unrelated transaction (see the Phase 9B-2
// zero-eligible-item accounting fix). Real revenue with zero new book
// entitlements to attribute it to -- purchases alone would under-report
// this author's actual revenue by exactly this amount.
type BundleSnapshotRevenue = SalesBundleSnapshot;

// ALL-TXN-CURRENCY-4: one line per currency, never a combined figure.
function CurrencyTotalsText({ totals, emptyLabel }: { totals: CurrencyTotals; emptyLabel: string }) {
  if (totals.totals.length === 0) {
    return <>{emptyLabel}</>;
  }
  return (
    <>
      {totals.totals.map((total) => (
        <span key={total.currency} className="block">
          {formatTransactionMinorUnits(total.amountMinor, total.currency)}
        </span>
      ))}
    </>
  );
}

export default async function SalesPage() {
  // ALL-CUTOVER APP-A: schema-sensitive dashboard sales page (V3 §3) --
  // checked as the first statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/sales");
  }

  const { data: books } = await supabase
    .from("books")
    .select("id, title, status")
    .eq("author_id", user.id)
    .returns<Pick<Book, "id" | "title" | "status">[]>();

  const bookIds = (books ?? []).map((book) => book.id);

  const { data: purchases } =
    bookIds.length > 0
      ? await supabase
          .from("purchases")
          .select(
            "id, book_id, amount_cents, created_at, stripe_checkout_session_id, stripe_payment_intent_id",
          )
          .in("book_id", bookIds)
          .is("refunded_at", null)
          .returns<PurchaseRow[]>()
      : { data: [] as PurchaseRow[] };

  // Own-client (RLS-respecting, not admin) read -- migration 027's
  // "Authors can view their own fulfilled bundle snapshot transactions"
  // policy is what makes this legal; it also already restricts these
  // rows to auth.uid() = author_id and fulfilled_at is not null, so an
  // in-flight/unpaid/expired checkout stays invisible here regardless of
  // this query's own filters. refunded_at is filtered explicitly anyway,
  // matching this page's existing purchases query style, rather than
  // relying solely on the RLS policy (which doesn't cover refund state).
  const { data: snapshots } = await supabase
    .from("bundle_checkout_snapshots")
    .select(
      "stripe_checkout_session_id, stripe_payment_intent_id, total_amount_cents, fulfilled_at, currency",
    )
    .eq("author_id", user.id)
    .not("fulfilled_at", "is", null)
    .is("refunded_at", null)
    .returns<BundleSnapshotRevenue[]>();

  const { data: views } =
    bookIds.length > 0
      ? await supabase
          .from("book_views")
          .select("book_id")
          .in("book_id", bookIds)
          .returns<{ book_id: string }[]>()
      : { data: [] as { book_id: string }[] };

  const rawPurchaseRows = purchases ?? [];
  const rawSnapshots = snapshots ?? [];
  const allViews = views ?? [];

  // LAUNCH-1 P1-8/P2-2: a lost-disputed purchase must not be represented
  // as active author revenue -- refunded_at alone (the filter already
  // applied to both queries above) never covers this, since a dispute
  // never sets refunded_at. LAUNCH-1 P2-2 replaced the caller-supplied-
  // id RPC this used to call with author_lost_disputed_payment_intents()
  // -- a zero-argument RPC that re-derives this author's own candidate
  // payment-intent set (from BOTH purchases and fulfilled bundle
  // snapshots -- a bundle's purchases rows and its own snapshot row
  // always share one payment intent, see the P1-7A/P1-8 audits) from
  // auth.uid() server-side, rather than trusting this page to have
  // scoped its own input correctly. See the P2-2 audit/design report
  // for why a caller-supplied text[] of arbitrary payment-intent ids was
  // an unnecessary privilege surface even though this was its only
  // legitimate caller.
  //
  // A failed RPC call must NOT be treated as "there are zero lost
  // disputes" -- silently continuing with an empty exclusion set would
  // overstate this author's revenue by including disputed-and-lost
  // transactions as if they were still active. Fails safely instead:
  // logged, then thrown, which Next.js renders as a generic error page
  // rather than a page showing numbers that may be wrong.
  const { data: lostDisputed, error: lostDisputedError } = await supabase.rpc(
    "author_lost_disputed_payment_intents",
  );

  if (lostDisputedError) {
    console.error("SalesPage: author_lost_disputed_payment_intents RPC failed", {
      authorId: user.id,
      error: lostDisputedError,
    });
    throw new Error("Could not load sales data. Please try again.");
  }

  const lostDisputedPaymentIntentIds = new Set(
    ((lostDisputed ?? []) as { stripe_payment_intent_id: string }[]).map(
      (row) => row.stripe_payment_intent_id,
    ),
  );

  // ALL-TXN-CURRENCY-4: the currency of each purchases row. purchases
  // has no currency column and payments is finance-staff-only, so this
  // comes from list_purchase_currencies() -- scoped server-side to
  // purchases of the caller's own books, currency facts only. Same
  // fail-safe posture as the dispute read above: a failed read must not
  // be treated as "every sale is in some currency", so it throws rather
  // than render totals built on a guess. A row the RPC does not return
  // stays 'unknown' and is excluded from every money figure.
  const currencyByPurchaseId = new Map<string, CurrencyProvenance>();
  if (rawPurchaseRows.length > 0) {
    const { data: currencyRows, error: currencyError } = await supabase.rpc(
      "list_purchase_currencies",
      { p_purchase_ids: rawPurchaseRows.map((purchase) => purchase.id) },
    );
    if (currencyError) {
      console.error("SalesPage: list_purchase_currencies RPC failed", {
        authorId: user.id,
        error: currencyError,
      });
      throw new Error("Could not load sales data. Please try again.");
    }
    for (const row of (currencyRows ?? []) as PurchaseCurrencyRow[]) {
      currencyByPurchaseId.set(
        row.purchase_id,
        parseCurrencyProvenance(row.currency_state, row.currency),
      );
    }
  }
  const rawPurchases: SalesPurchase[] = rawPurchaseRows.map((purchase) => ({
    ...purchase,
    currency: currencyByPurchaseId.get(purchase.id) ?? { state: "unknown" },
  }));

  const allPurchases = excludeLostDisputedRows(rawPurchases, lostDisputedPaymentIntentIds);
  const filteredSnapshots = excludeLostDisputedRows(rawSnapshots, lostDisputedPaymentIntentIds);

  // A normal or partial-ownership bundle checkout's revenue is already
  // fully represented by the purchases rows it wrote (their amounts sum
  // to the snapshot's own total_amount_cents by construction -- see the
  // webhook's allocation logic) -- adding the snapshot's total again
  // here would double-count it. Only a snapshot whose Stripe Checkout
  // Session ID does NOT appear among this author's own purchases
  // qualifies as supplementary, not-yet-represented revenue: the
  // zero-eligible-item case where every book was already owned, so
  // fulfillment wrote no purchases row at all for that payment.
  const transactionOnlySnapshots = selectTransactionOnlySnapshots(allPurchases, filteredSnapshots);

  // "Units" means books acquired -- one purchases row per book per
  // reader (see the `purchases` table's own unique(book_id, reader_id)
  // constraint and this page's per-book breakdown below, both keyed on
  // book_id). A transaction-only snapshot has no purchases row and
  // therefore no book to count -- it must NOT increment Units, and
  // doesn't: totalUnitsSold is computed from allPurchases alone, exactly
  // as before this change.
  const totalUnitsSold = allPurchases.length;
  const totalViews = allViews.length;
  const publishedCount =
    books?.filter((book) => book.status === "published").length ?? 0;

  // ALL-TXN-CURRENCY-4: every money figure below -- headline net
  // revenue, per-book net revenue, and the daily chart -- is kept per
  // currency by summarizeSalesRevenue (see revenue-logic.ts), with the
  // lost-dispute exclusion, refund exclusion and snapshot
  // anti-double-counting above left exactly as they were.
  const summary = summarizeSalesRevenue({
    books: books ?? [],
    purchases: allPurchases,
    transactionOnlySnapshots,
    today: new Date(),
    chartDays: CHART_DAYS,
  });
  const viewsByBookId = new Map<string, number>();
  for (const view of allViews) {
    viewsByBookId.set(view.book_id, (viewsByBookId.get(view.book_id) ?? 0) + 1);
  }

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>

      <div className="mt-2">
        <PageHeader title="Sales" description="Your net revenue, after Librum's platform fee." />
      </div>

      <p className="mt-3 text-sm text-muted">
        This is an estimate from your order history. For your official ledger
        balance, pending settlement, and payout history, see{" "}
        <Link href="/dashboard/balance" className="font-medium text-primary hover:underline">
          Financial Balance
        </Link>
        .
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-sm text-muted">Net revenue</p>
          <p className="mt-1 font-serif text-2xl font-semibold text-primary">
            <CurrencyTotalsText totals={summary.netTotals} emptyLabel="No sales yet" />
          </p>
          {summary.netTotals.unresolvedCount > 0 && (
            <p className="mt-1 text-xs text-muted">
              {summary.netTotals.unresolvedCount === 1
                ? "1 sale is not included: its currency could not be determined."
                : `${summary.netTotals.unresolvedCount} sales are not included: their currency could not be determined.`}
            </p>
          )}
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-sm text-muted">Units</p>
          <p className="mt-1 font-serif text-2xl font-semibold">
            {totalUnitsSold}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-sm text-muted">Book page views</p>
          <p className="mt-1 font-serif text-2xl font-semibold">
            {totalViews}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-sm text-muted">Published books</p>
          <p className="mt-1 font-serif text-2xl font-semibold">
            {publishedCount}
          </p>
        </div>
      </div>

      <h2 className="mt-10 font-serif text-xl font-semibold">
        Net revenue, last {CHART_DAYS} days
      </h2>
      {summary.dailySeries.length === 0 ? (
        <div className="mt-4 flex h-32 items-end gap-1.5 rounded-lg border border-border bg-surface p-4 shadow-sm">
          {summary.chartDates.map((date) => (
            <div
              key={date.toISOString()}
              className="flex h-full flex-1 flex-col items-center justify-end gap-1"
            >
              <div className="w-full rounded-t bg-primary" style={{ height: "2%" }} />
              <span className="text-[10px] text-muted">{date.getDate()}</span>
            </div>
          ))}
        </div>
      ) : (
        // One chart per currency: bars are only ever scaled against days
        // of the SAME currency, never against another currency's sales.
        summary.dailySeries.map((series) => {
          const maxMinor = Math.max(1, ...series.days.map((d) => d.netMinor));
          return (
            <section key={series.currency} className="mt-4">
              <h3 className="text-sm font-medium text-muted">{series.currency}</h3>
              <div className="mt-2 flex h-32 items-end gap-1.5 rounded-lg border border-border bg-surface p-4 shadow-sm">
                {series.days.map((day) => (
                  <div
                    key={day.date.toISOString()}
                    className="flex h-full flex-1 flex-col items-center justify-end gap-1"
                    title={`${day.date.toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}: ${formatTransactionMinorUnits(day.netMinor, series.currency)}`}
                  >
                    <div
                      className="w-full rounded-t bg-primary"
                      style={{
                        height: `${Math.max(2, (day.netMinor / maxMinor) * 100)}%`,
                      }}
                    />
                    <span className="text-[10px] text-muted">
                      {day.date.getDate()}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}

      <h2 className="mt-10 font-serif text-xl font-semibold">
        By book
      </h2>
      {summary.perBook.length === 0 ? (
        <EmptyState className="mt-4" title="No books yet." />
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {summary.perBook.map((book) => {
            const views = viewsByBookId.get(book.id) ?? 0;
            return (
              <li
                key={book.id}
                className="flex flex-wrap items-center justify-between gap-2 py-3"
              >
                <span className="font-serif font-medium">{book.title}</span>
                <span className="text-sm text-muted">
                  {views} view{views === 1 ? "" : "s"}
                </span>
                <span className="text-sm text-muted">
                  {book.unitsSold} unit{book.unitsSold === 1 ? "" : "s"}
                </span>
                <span className="text-sm font-semibold text-primary">
                  <CurrencyTotalsText totals={book.net} emptyLabel="No revenue" />
                  {book.net.unresolvedCount > 0 && (
                    <span className="block text-xs font-normal text-muted">
                      + {book.net.unresolvedCount} with unknown currency
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
