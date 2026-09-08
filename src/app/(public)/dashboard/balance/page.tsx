import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getAuthorFinancialSummary,
  listAuthorFinancialActivity,
  getAuthorPayoutOverview,
  listAuthorPayoutHistory,
  getAuthorPayoutDestination,
  saveAuthorPayoutDestination,
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
  maskIban,
  PAYOUT_DESTINATION_CURRENCY,
  isBankPayoutSetupEnabled,
} from "./balance-logic";
import { AUTHOR_EARNINGS_SETTLEMENT_DAYS } from "@/lib/settlement-policy";
import { isSchedulerEnabled } from "@/lib/payout-scheduler";
import { computeNextPayoutCycleDate, formatPayoutCycleDate } from "@/lib/payout-cycle";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
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
export default async function BalancePage({
  searchParams,
}: {
  searchParams: Promise<{ editBank?: string; error?: string; success?: string }>;
}) {
  const { editBank, error: queryError, success: querySuccess } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/dashboard/balance");
  }

  // LEDGER-1E-D-G: gates the "Next payout cycle" notice below on the
  // same fail-closed switch the scheduler route itself reads (never a
  // second, possibly-drifting definition of "enabled") -- see
  // isSchedulerEnabled() in src/lib/payout-scheduler.ts. Still unset in
  // production as of this change, so this remains the disabled branch
  // today; nothing here arms reservation execution.
  const schedulerEnabled = isSchedulerEnabled(process.env.PAYOUT_SCHEDULER_ENABLED);

  // BANK-PAYOUT-1E.1: a SEPARATE rollout switch from schedulerEnabled
  // above -- this one gates only whether the bank-destination setup UI
  // (and its underlying read) is shown at all, independent of whether
  // reservation execution is armed. Stripe Connect remains the live
  // author-payout mechanism today; this stays off until a future,
  // explicit cutover task turns it on (see balance-logic.ts's own
  // comment on isBankPayoutSetupEnabled for the full reasoning).
  const bankPayoutSetupEnabled = isBankPayoutSetupEnabled(process.env.BANK_PAYOUT_SETUP_ENABLED);

  const [summaryResult, activityResult, overviewResult, historyResult, destinationResult] = await Promise.all([
    getAuthorFinancialSummary(),
    listAuthorFinancialActivity({ limit: ACTIVITY_DISPLAY_PAGE_SIZE + 1 }),
    getAuthorPayoutOverview(),
    listAuthorPayoutHistory({ limit: PAYOUT_HISTORY_DISPLAY_PAGE_SIZE + 1 }),
    // Section 8/9: never query the author's full stored bank
    // destination while the setup UI is disabled -- there is nothing
    // to show it for, so this is a real data-minimization gate, not
    // merely a hidden-in-the-UI one. getAuthorPayoutDestination() is
    // literally never called in this state.
    bankPayoutSetupEnabled
      ? getAuthorPayoutDestination()
      : Promise.resolve({ ok: true, data: null } as Awaited<ReturnType<typeof getAuthorPayoutDestination>>),
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
  if (!destinationResult.ok) {
    throw new Error(destinationResult.error);
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

  // BANK-PAYOUT-1E Section 12: the platform minimum policy is GLOBAL,
  // not per-author, so its configured-state is read from whichever ALL
  // overview row exists. get_author_payout_overview() only ever returns
  // a row for a currency the author already has ledger activity,
  // settings, or past payouts in (its own "currencies" CTE) -- a
  // first-time author with none of those gets no ALL row at all. The
  // honest default when that row is absent is "not configured", never
  // a fabricated true -- exactly matching what a real query against
  // payout_minimum_policy would say for this author's own effective
  // state today.
  const destination = destinationResult.data;
  const overviewForDestinationCurrency = overviewByCurrency.get(PAYOUT_DESTINATION_CURRENCY);
  const minimumPolicyConfigured = overviewForDestinationCurrency?.minimum_policy_configured ?? false;
  const isEditingBank = editBank === "1";

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="focus-ring rounded-sm text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>

      <div className="mt-2">
        <PageHeader
          title="Financial Balance"
          description={`Your ledger balance across every sale, refund, adjustment, and payout. New sales settle ${AUTHOR_EARNINGS_SETTLEMENT_DAYS} days after purchase, once Librum's refund window has closed, and become available for payout at that point${schedulerEnabled ? "." : " — an exact payout date isn't scheduled yet."}`}
        />
      </div>

      {queryError && (
        <Alert variant="error" className="mt-4">
          {queryError}
        </Alert>
      )}
      {querySuccess && (
        <Alert variant="success" className="mt-4">
          {querySuccess}
        </Alert>
      )}

      {/* LEDGER-1E-D-G: forward-looking payout-cycle policy notice --
          shown regardless of isEmpty below, since it's schedule
          information, not historical ledger data. Never shows a "Next
          payout cycle" date while the scheduler is disabled (Section
          14's own explicit rule): a real date here would promise
          scheduling that isn't actually armed yet. */}
      <Alert
        variant="info"
        className="mt-4"
        title={
          schedulerEnabled
            ? `Next payout cycle: ${formatPayoutCycleDate(computeNextPayoutCycleDate())}`
            : undefined
        }
      >
        {schedulerEnabled
          ? "Once your available balance meets your payout threshold, it will be reserved for payout during this cycle."
          : "Monthly payout scheduling is not yet active."}
      </Alert>

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

      {/* BANK-PAYOUT-1E.1: the ENTIRE bank-destination setup section is
          gated on bankPayoutSetupEnabled and OMITTED ENTIRELY while
          disabled (option A of Section 5) -- not merely hidden behind a
          disabled form. Stripe Connect remains the only live author-
          payout mechanism today, and showing this section (even as an
          informational notice) risks telling authors they need to set
          up two competing payout systems. The underlying read is
          already skipped above when disabled, so this omission is a
          real data-minimization boundary, not cosmetic. */}
      {bankPayoutSetupEnabled && (
      /* BANK-PAYOUT-1E: bank destination + threshold-readiness setup --
          deliberately rendered UNCONDITIONALLY (once enabled), outside
          the isEmpty branch above, since an author with zero sales so
          far still needs to be able to add a bank account before
          payouts are ever activated (Section 19's own empty-state
          requirement). Bank data flows exclusively through the live
          migration-055 set_author_payout_destination() RPC (via the
          Server Action in ./actions.ts) -- no direct write to
          author_payout_destinations anywhere here, and no author_id is
          ever read from or sent by this page. This is a SEPARATE
          concern from the existing Stripe Connect onboarding at
          /dashboard/payouts (left untouched by this task -- that page
          still gates real paid-book publishing today) -- this section
          only prepares the NOT-YET-ACTIVE bank-transfer payout path
          this migration foundation exists for. */
      <section className="mt-10 border-t border-border pt-8">
        <h2 className="font-serif text-xl font-semibold">Payout setup</h2>

        <div className="mt-4 rounded-lg border border-border bg-surface p-4 shadow-sm">
          <h3 className="font-serif text-base font-semibold">Bank account</h3>

          {destination && !isEditingBank ? (
            <>
              <p className="mt-2 text-sm font-medium text-emerald-700">&#10003; Added</p>
              <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-muted">Account holder</dt>
                  <dd className="font-medium">{destination.beneficiary_name}</dd>
                </div>
                <div>
                  <dt className="text-muted">IBAN</dt>
                  <dd className="font-medium">{maskIban(destination.iban)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Currency</dt>
                  <dd className="font-medium">{destination.currency}</dd>
                </div>
              </dl>
              <Link
                href="/dashboard/balance?editBank=1"
                className={buttonClasses("outline", "sm", "mt-4")}
              >
                Change bank account
              </Link>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-muted">
                {destination
                  ? "Changing your bank account affects future payouts only. Any payout already being processed keeps the bank details frozen for that payout."
                  : "Add a bank account to become eligible for payouts once payouts are activated."}
              </p>

              <form action={saveAuthorPayoutDestination} className="mt-4 flex flex-col gap-4">
                <label className="flex flex-col gap-1 text-sm">
                  Account holder name
                  <input
                    name="beneficiaryName"
                    type="text"
                    required
                    autoComplete="off"
                    placeholder="Full name on the bank account"
                    className={formControlClasses}
                  />
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  IBAN
                  <input
                    name="iban"
                    type="text"
                    required
                    autoComplete="off"
                    placeholder="AL47 2121 1009 0000 0002 3569 8741"
                    className={formControlClasses}
                  />
                  <span className="text-xs text-muted">
                    We check that this is a validly formatted IBAN — this confirms the format
                    only, not that the account belongs to you.
                  </span>
                </label>

                <div className="flex flex-col gap-1 text-sm">
                  <span>Currency</span>
                  <span className="text-muted">{PAYOUT_DESTINATION_CURRENCY} (Albanian Lek)</span>
                </div>

                <div className="mt-1 flex flex-wrap gap-3">
                  <button type="submit" className={buttonClasses("primary", "md")}>
                    Save bank account
                  </button>
                  {destination && (
                    <Link href="/dashboard/balance" className={buttonClasses("outline", "md")}>
                      Cancel
                    </Link>
                  )}
                </div>
              </form>
            </>
          )}
        </div>

        <div className="mt-4 rounded-lg border border-border bg-surface p-4 shadow-sm">
          <h3 className="font-serif text-base font-semibold">Payout threshold</h3>
          <p className="mt-2 text-sm text-muted">
            {minimumPolicyConfigured
              ? "Payout threshold is ready to be set."
              : "Payout threshold will become available when Librum activates its minimum payout policy."}
          </p>
        </div>
      </section>
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
