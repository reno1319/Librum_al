import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthorFinancialSummary,
  listAuthorFinancialActivity,
  getAuthorPayoutOverview,
  listAuthorPayoutHistory,
} from "./actions";
import {
  formatMinorAmount,
  entryTypeLabel,
  hasAnyLedgerActivity,
  resolveActivityPage,
  ACTIVITY_DISPLAY_PAGE_SIZE,
  payoutStatusLabel,
  resolvePayoutHistoryPage,
  PAYOUT_HISTORY_DISPLAY_PAGE_SIZE,
} from "./balance-logic";
import { AUTHOR_EARNINGS_SETTLEMENT_DAYS } from "@/lib/settlement-policy";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import type { AuthorPayoutOverviewRow } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Financial Balance",
};

// LEDGER-1D: the author-facing financial ledger read model --
// everything here comes from get_author_financial_summary() and
// list_author_financial_activity() (migration 050), never from
// `purchases`/PLATFORM_FEE_PERCENT. Deliberately a SEPARATE page from
// /dashboard/sales rather than a merge: Sales still shows the existing
// per-purchase 80/20 estimate (kept unchanged), while this page shows
// the actual ledger -- currently empty in production, since no current
// Stripe checkout/webhook path writes ledger entries yet (see that
// migration's own top-of-file comment). Combining the two into one
// number would produce two competing definitions of "revenue" under one
// label, which is exactly what LEDGER-1D was asked to avoid.
export default async function BalancePage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/balance");
  }

  const [summaryResult, activityResult, overviewResult, historyResult] = await Promise.all([
    getAuthorFinancialSummary(),
    listAuthorFinancialActivity({ limit: ACTIVITY_DISPLAY_PAGE_SIZE + 1 }),
    getAuthorPayoutOverview(),
    listAuthorPayoutHistory({ limit: PAYOUT_HISTORY_DISPLAY_PAGE_SIZE + 1 }),
  ]);

  if (!summaryResult.ok) {
    throw new Error(summaryResult.error);
  }
  if (!activityResult.ok) {
    throw new Error(activityResult.error);
  }
  if (!overviewResult.ok) {
    throw new Error(overviewResult.error);
  }
  if (!historyResult.ok) {
    throw new Error(historyResult.error);
  }

  const summary = summaryResult.data;
  const { rows: activity } = resolveActivityPage(activityResult.data);
  const { rows: payoutHistory } = resolvePayoutHistoryPage(historyResult.data);
  const isEmpty = !hasAnyLedgerActivity(summary);

  // LEDGER-1E-C: keyed by currency so each ledger row below can look up
  // its own reservation-aware payoutability -- overview is now the
  // authoritative source for the "Available for payout" card; raw
  // ledger available_minor (get_author_financial_summary(), untouched)
  // is never itself labeled "Available for payout" once a reservation
  // could exist. When reserved_minor is 0 the two numbers are identical
  // anyway (no information is lost); when it isn't, the separate
  // "Reserved for payout" card below makes the relationship visible
  // instead of adding a third, redundant "ledger balance" card.
  const overviewByCurrency = new Map<string, AuthorPayoutOverviewRow>(
    overviewResult.data.map((row) => [row.currency, row]),
  );

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>

      <div className="mt-2">
        <PageHeader
          title="Financial Balance"
          description={`Your ledger balance across every sale, refund, adjustment, and payout. New sales settle ${AUTHOR_EARNINGS_SETTLEMENT_DAYS} days after purchase, once Librum's refund window has closed, and become available for payout at that point — an exact payout date isn't scheduled yet.`}
        />
      </div>

      {isEmpty ? (
        <EmptyState
          className="mt-8"
          title="No ledger activity yet."
          description="Once a sale is recorded to your ledger, your balance and activity will appear here."
        />
      ) : (
        <>
          {summary.map((row) => {
            // LEDGER-1E-C: overview is the authoritative source for
            // "available for payout" now that a reservation can exist --
            // this deliberately does NOT redefine row.available_minor
            // (pure ledger truth, untouched, still shown below as
            // "Ledger balance"). Falling back to the raw ledger figure
            // only covers the structurally-unreachable case where this
            // currency has ledger rows but no matching overview row.
            const overview = overviewByCurrency.get(row.currency);
            const availableForPayout = overview?.available_for_payout_minor ?? row.available_minor;
            const reserved = overview?.reserved_minor ?? 0;

            return (
              <section key={row.currency} className="mt-8">
                <h2 className="font-serif text-lg font-semibold">{row.currency}</h2>

                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-4">
                  <BalanceCard
                    label="Available for payout"
                    amountMinor={availableForPayout}
                    currency={row.currency}
                    emphasize
                  />
                  {reserved > 0 && (
                    <BalanceCard label="Reserved for payout" amountMinor={reserved} currency={row.currency} />
                  )}
                  <BalanceCard
                    label="Pending settlement"
                    amountMinor={row.pending_minor}
                    currency={row.currency}
                  />
                  <BalanceCard
                    label="Net earnings"
                    amountMinor={row.net_earnings_minor}
                    currency={row.currency}
                  />
                  <BalanceCard
                    label="Paid out"
                    amountMinor={row.paid_out_minor}
                    currency={row.currency}
                  />
                </div>

                {overview?.threshold_configured === false && (
                  <p className="mt-3 text-xs text-muted">Payout threshold not configured yet.</p>
                )}
                {overview?.threshold_reached && (
                  <p className="mt-3 text-xs text-muted">Threshold reached.</p>
                )}

                <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-muted">Lifetime sales</dt>
                    <dd className="font-medium">
                      {formatMinorAmount(row.lifetime_sale_minor, row.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Refunds</dt>
                    <dd className="font-medium">
                      {formatMinorAmount(row.lifetime_refund_minor, row.currency)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Adjustments</dt>
                    <dd className="font-medium">
                      {formatMinorAmount(row.lifetime_adjustment_minor, row.currency)}
                    </dd>
                  </div>
                </dl>
              </section>
            );
          })}

          <h2 className="mt-10 font-serif text-xl font-semibold">Recent activity</h2>
          {activity.length === 0 ? (
            <EmptyState className="mt-4" title="No activity yet." />
          ) : (
            <ul className="mt-4 divide-y divide-border">
              {activity.map((entry) => (
                <li
                  key={entry.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <span className="font-serif font-medium">{entryTypeLabel(entry.entry_type)}</span>
                  <span className="text-sm text-muted">
                    {entry.book_title ?? "—"}
                  </span>
                  <span className="text-sm text-muted">
                    {new Date(entry.created_at).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <span className="text-sm font-semibold text-primary">
                    {formatMinorAmount(entry.amount_minor, entry.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {/* LEDGER-1E-C: safe payout history -- amount/currency/status/date
              only, via list_author_payout_history(). No provider/reference/
              failure detail, no controls -- this is reporting only, not the
              legacy Stripe Connect onboarding UI (that stays at
              /dashboard/payouts, untouched). */}
          <h2 className="mt-10 font-serif text-xl font-semibold">Payout history</h2>
          {payoutHistory.length === 0 ? (
            <EmptyState className="mt-4" title="No payouts yet." />
          ) : (
            <ul className="mt-4 divide-y divide-border">
              {payoutHistory.map((payout) => (
                <li
                  key={payout.id}
                  className="flex flex-wrap items-center justify-between gap-2 py-3"
                >
                  <span className="font-serif font-medium">{payoutStatusLabel(payout.status)}</span>
                  <span className="text-sm text-muted">
                    {new Date(payout.created_at).toLocaleDateString(undefined, {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    })}
                  </span>
                  <span className="text-sm font-semibold text-primary">
                    {formatMinorAmount(payout.amount_minor, payout.currency)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      <Alert variant="info" className="mt-10">
        Looking for unit sales and page views? See{" "}
        <Link href="/dashboard/sales" className="font-medium underline">
          Sales
        </Link>
        .
      </Alert>
    </main>
  );
}

function BalanceCard({
  label,
  amountMinor,
  currency,
  emphasize,
}: {
  label: string;
  amountMinor: number;
  currency: string;
  emphasize?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
      <p className="text-sm text-muted">{label}</p>
      <p
        className={
          emphasize
            ? "mt-1 font-serif text-2xl font-semibold text-primary"
            : "mt-1 font-serif text-2xl font-semibold"
        }
      >
        {formatMinorAmount(amountMinor, currency)}
      </p>
    </div>
  );
}
