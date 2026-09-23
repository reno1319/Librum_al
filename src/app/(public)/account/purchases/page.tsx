import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Book, RefundRequest } from "@/lib/types";
import {
  calculateTotalSpentByCurrency,
  deriveTransactionRefundState,
  groupPurchasesByTransaction,
  isWithinRefundEligibilityWindow,
  type BundleSnapshotForGrouping,
} from "@/app/(public)/library/refund-logic";
import { requestTransactionRefund, cancelRefundRequest } from "@/app/(public)/library/refund-actions";
import { RefundRequestForm } from "@/app/(public)/library/refund-request-form";
import { CancelRefundButton } from "@/app/(public)/library/cancel-refund-button";
import { PageHeader } from "@/components/ui/page-header";
import { Alert } from "@/components/ui/alert";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import {
  formatTransactionAmount,
  formatTransactionMinorUnits,
  parseCurrencyProvenance,
  type CurrencyProvenance,
} from "@/lib/transaction-money";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Purchases & refunds",
  description: "Review your purchases and manage eligible refund requests.",
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see the exhaustive
// route audit (purchases.amount_cents, bundle_checkout_snapshots.
// total_amount_cents, and their embedded item amounts are all rendered
// below).
export const dynamic = "force-dynamic";

// LIBRUM 2.0 UI-9 / ACCOUNT-1: the transaction-history home, moved here
// directly from the Library page (which now owns current-ownership/
// download access only -- see the UI-9 audit's ACCOUNT boundary). The
// business logic below is untouched from its Library incarnation: same
// queries, same refund-logic.ts/refund-actions.ts imports (reused
// as-is, not duplicated), same eligibility/status semantics. Only the
// route, its own auth-redirect target, and the surrounding page chrome
// are new.
type PurchaseRow = {
  id: string;
  book_id: string;
  amount_cents: number;
  created_at: string;
  refunded_at: string | null;
  stripe_payment_intent_id: string | null;
  books: Book | null;
};

type PurchaseWithBook = PurchaseRow & { currency: CurrencyProvenance };

type PurchaseCurrencyRow = {
  purchase_id: string;
  currency_state: string;
  currency: string | null;
};

const REFUND_STATUS_LABELS: Record<string, string> = {
  requested: "Refund requested",
  approved: "Refund approved",
  rejected: "Refund request rejected",
  refunded: "Refunded",
  cancelled: "Refund request cancelled",
};

export default async function AccountPurchasesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive page -- renders
  // purchases.amount_cents and bundle_checkout_snapshots.
  // total_amount_cents (exhaustive route audit) -- checked as the first
  // statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { error, success } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account/purchases");
  }

  const { data: purchases } = await supabase
    .from("purchases")
    .select("id, book_id, amount_cents, created_at, refunded_at, stripe_payment_intent_id, books(*)")
    .eq("reader_id", user.id)
    .order("created_at", { ascending: false })
    .returns<PurchaseRow[]>();

  // RLS ("Readers can view their own fulfilled bundle snapshot
  // transactions" -- migration 030) already scopes this to the caller's
  // own, completed transactions -- the .eq/.not filters below are
  // belt-and-suspenders, matching the same explicit-filter-alongside-RLS
  // convention the purchases query above already uses. Only fulfilled,
  // payment-intent-bearing snapshots are fetched: an in-flight/expired
  // checkout is never visible (fulfilled_at is not null, matching the
  // policy itself), and a snapshot with no payment intent (a genuinely
  // free/$0 bundle) has nothing refundable, so there's no reason to fetch
  // it here.
  const { data: bundleSnapshots } = await supabase
    .from("bundle_checkout_snapshots")
    .select("id, stripe_payment_intent_id, total_amount_cents, fulfilled_at, refunded_at, items, currency")
    .eq("reader_id", user.id)
    .not("fulfilled_at", "is", null)
    .not("stripe_payment_intent_id", "is", null)
    .returns<BundleSnapshotForGrouping[]>();

  // RLS ("Readers can view their own refund requests") already scopes
  // this to the caller's own rows -- the .eq below is belt-and-suspenders,
  // matching the same explicit-filter-alongside-RLS convention the
  // purchases query above already uses.
  const { data: refundRequests } = await supabase
    .from("refund_requests")
    .select("id, stripe_payment_intent_id, status, reason, requested_at")
    .eq("reader_id", user.id)
    .order("requested_at", { ascending: true })
    .returns<RefundRequest[]>();

  // Later entries overwrite earlier ones, so this ends up holding each
  // payment intent's most recent refund request -- the one relevant to
  // "can the reader request/cancel a refund right now."
  const latestRequestByPaymentIntent = new Map<string, RefundRequest>();
  for (const request of refundRequests ?? []) {
    latestRequestByPaymentIntent.set(request.stripe_payment_intent_id, request);
  }

  // ALL-TXN-CURRENCY-4: purchases has no currency column, and the
  // table that states it (payments) is finance-staff-only, so each row's
  // currency comes from list_purchase_currencies() -- a SECURITY DEFINER
  // read scoped to the caller's own rows, returning currency facts only.
  // A failed or partial read degrades every affected row to 'unknown'
  // ("Amount unavailable"), never to a guessed currency: the rest of the
  // page (downloads, refund requests) must stay usable either way.
  const rawPurchases = purchases ?? [];
  const currencyByPurchaseId = new Map<string, CurrencyProvenance>();
  if (rawPurchases.length > 0) {
    const { data: currencyRows, error: currencyError } = await supabase.rpc(
      "list_purchase_currencies",
      { p_purchase_ids: rawPurchases.map((purchase) => purchase.id) },
    );
    if (currencyError) {
      console.error("AccountPurchasesPage: list_purchase_currencies RPC failed", {
        error: currencyError,
      });
    }
    for (const row of (currencyRows ?? []) as PurchaseCurrencyRow[]) {
      currencyByPurchaseId.set(
        row.purchase_id,
        parseCurrencyProvenance(row.currency_state, row.currency),
      );
    }
  }
  const allPurchases: PurchaseWithBook[] = rawPurchases.map((purchase) => ({
    ...purchase,
    currency: currencyByPurchaseId.get(purchase.id) ?? { state: "unknown" },
  }));

  // LAUNCH-1 P1-7B: refunded_at alone is no longer sufficient to decide
  // whether a listed purchase is still actively downloadable -- a
  // lost-disputed purchase (migration 035) never sets refunded_at, so
  // it must also read as not-currently-owned here, exactly like the
  // book detail and bundle pages' own "owned" checks (both already
  // routed through this same RPC). One call per distinct purchases row
  // -- purchases has unique(book_id, reader_id), so this is exactly one
  // call per book actually listed on this page, not per transaction
  // group. A bundle transaction whose books share one Stripe
  // PaymentIntent needs no special-casing: user_owns_book() keys off
  // each book's OWN purchases row, and every book in that bundle
  // carries that same shared payment intent, so a lost dispute on it
  // correctly revokes every one of those books here, not just one.
  const ownershipEntries = await Promise.all(
    allPurchases.map(
      async (purchase) =>
        [
          purchase.book_id,
          !!(await supabase.rpc("user_owns_book", { target_book_id: purchase.book_id })).data,
        ] as const,
    ),
  );
  const ownedByBookId = new Map(ownershipEntries);

  // Merges purchases rows AND fulfilled bundle snapshots into one entry
  // per actual paid transaction -- including a transaction with zero
  // purchases rows (every bundle item was already owned elsewhere), which
  // would otherwise be completely absent from this page. See
  // groupPurchasesByTransaction's own documentation for the full model.
  const transactionGroups = groupPurchasesByTransaction(allPurchases, bundleSnapshots ?? []);

  // Derived from the same deduplicated transaction model above, not
  // re-summed from raw purchases rows -- see calculateTotalSpentByCurrency's
  // own documentation for why (avoids double-counting a normal bundle's
  // purchases rows against its snapshot, and now correctly includes a
  // zero-purchase-rows paid bundle transaction, which the original
  // purchases-only sum silently omitted).
  const totalSpent = calculateTotalSpentByCurrency(transactionGroups);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <PageHeader
        title="Purchases & refunds"
        description="Review your purchases and manage eligible refund requests."
      />

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}
      {success && (
        <Alert variant="success" className="mt-4">
          {success}
        </Alert>
      )}

      {transactionGroups.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          You haven&apos;t bought any books yet.
        </p>
      ) : (
        <>
          {/* One figure per currency, never a converted or combined
              total -- see calculateTotalSpentByCurrency. */}
          <div className="mt-6 text-sm text-muted">
            {totalSpent.totals.length === 0 ? (
              <p>Total spent: nothing yet</p>
            ) : (
              <p>
                Total spent:{" "}
                {totalSpent.totals.map((total, index) => (
                  <span key={total.currency}>
                    {index > 0 && " · "}
                    <span className="font-semibold text-primary">
                      {formatTransactionMinorUnits(total.amountMinor, total.currency)}
                    </span>
                  </span>
                ))}
              </p>
            )}
            {totalSpent.unresolvedCount > 0 && (
              <p className="mt-1 text-xs">
                {totalSpent.unresolvedCount === 1
                  ? "1 purchase is not included because its currency could not be determined."
                  : `${totalSpent.unresolvedCount} purchases are not included because their currency could not be determined.`}
              </p>
            )}
          </div>

          <ul className="mt-4 flex flex-col gap-4">
            {transactionGroups.map((group) => {
              // A transaction reads as a "bundle" card whenever it covers
              // more than one book OR has a matching snapshot at all --
              // covers the zero-/partial-eligibility cases, where
              // group.purchases.length alone would understate it (e.g. a
              // 1-purchases-row, 3-item partial bundle is still a bundle
              // transaction, not an ordinary single-book purchase).
              const isBundle = group.hasSnapshot || group.purchases.length > 1;
              const latestRequest = group.stripePaymentIntentId
                ? latestRequestByPaymentIntent.get(group.stripePaymentIntentId) ?? null
                : null;

              // Free acquisitions (stripePaymentIntentId === null) never
              // had a real Stripe transaction, so there's nothing to
              // request a refund for -- no refund UI at all for that
              // group, matching current behavior exactly.
              const refundState = group.stripePaymentIntentId
                ? deriveTransactionRefundState({
                    transactionRefunded: group.transactionRefunded,
                    latestRequestStatus: latestRequest?.status ?? null,
                  })
                : null;

              const withinWindow = isWithinRefundEligibilityWindow(group.eligibilityBasisDate);

              return (
                <li
                  key={group.key}
                  className={
                    isBundle
                      ? "rounded-lg border border-border bg-surface p-4 shadow-sm"
                      : "border-b border-border pb-4 last:border-b-0"
                  }
                >
                  {isBundle && (
                    <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted">
                      One purchase · {group.bookCount} books ·{" "}
                      {formatTransactionAmount(group.totalAmountCents, group.currency)}
                    </p>
                  )}

                  {group.purchases.length > 0 && (
                    <ul className={isBundle ? "flex flex-col gap-3" : undefined}>
                      {group.purchases.map((purchase) =>
                        purchase.books ? (
                          <li
                            key={purchase.book_id}
                            className="flex flex-wrap items-center justify-between gap-3"
                          >
                            <div>
                              <Link
                                href={`/books/${purchase.book_id}`}
                                className="font-serif font-medium hover:underline"
                              >
                                {purchase.books.title}
                              </Link>
                              <p className="text-xs text-muted">
                                Purchased{" "}
                                {new Date(purchase.created_at).toLocaleDateString(undefined, {
                                  year: "numeric",
                                  month: "short",
                                  day: "numeric",
                                })}{" "}
                                · {formatTransactionAmount(purchase.amount_cents, purchase.currency)}
                                {purchase.refunded_at && (
                                  <span className="ml-2 text-red-600">Refunded</span>
                                )}
                              </p>
                            </div>
                            {ownedByBookId.get(purchase.book_id) ? (
                              <a
                                href={`/api/books/${purchase.book_id}/download`}
                                className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
                              >
                                Download EPUB
                              </a>
                            ) : (
                              <span className="text-xs text-muted">No longer available</span>
                            )}
                          </li>
                        ) : null,
                      )}
                    </ul>
                  )}

                  {/* Books this checkout covered but did NOT newly grant
                      here, because the reader already owned them through a
                      different transaction (that transaction's own group,
                      elsewhere on this page, is what actually governs
                      their ownership/download state) -- listed as plain
                      text only, deliberately with no link and no download
                      control, so this can never be mistaken for a fresh
                      entitlement or a duplicate download affordance. */}
                  {group.unpurchasedSnapshotItems.length > 0 && (
                    <div className={group.purchases.length > 0 ? "mt-3" : undefined}>
                      <p className="text-xs text-muted">
                        {group.purchases.length > 0
                          ? "Also included in this purchase, already in your library:"
                          : "This purchase covered books already in your library:"}
                      </p>
                      <ul className="mt-1 text-xs text-muted">
                        {group.unpurchasedSnapshotItems.map((item) => (
                          <li key={item.bookId}>{item.title}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {refundState && (
                    <div className="mt-3 flex flex-wrap items-center gap-3">
                      {refundState.statusLabel && (
                        <span className="text-xs font-medium text-muted">
                          {REFUND_STATUS_LABELS[refundState.statusLabel]}
                        </span>
                      )}

                      {refundState.showCancelButton && latestRequest && (
                        <form action={cancelRefundRequest.bind(null, latestRequest.id)}>
                          <CancelRefundButton />
                        </form>
                      )}

                      {refundState.showRequestButton &&
                        (withinWindow ? (
                          <RefundRequestForm
                            action={requestTransactionRefund.bind(
                              null,
                              group.stripePaymentIntentId as string,
                            )}
                            bookCount={group.bookCount}
                          />
                        ) : (
                          <span className="text-xs text-muted">
                            No longer eligible for a refund request (past the 14-day window)
                          </span>
                        ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
