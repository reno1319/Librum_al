import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Book, RefundRequest } from "@/lib/types";
import {
  calculateTotalSpentCents,
  deriveTransactionRefundState,
  groupPurchasesByTransaction,
  isWithinRefundEligibilityWindow,
  type BundleSnapshotForGrouping,
} from "./refund-logic";
import { requestTransactionRefund, cancelRefundRequest } from "./refund-actions";
import { RefundRequestForm } from "./refund-request-form";
import { CancelRefundButton } from "./cancel-refund-button";

type PurchaseWithBook = {
  book_id: string;
  amount_cents: number;
  created_at: string;
  refunded_at: string | null;
  stripe_payment_intent_id: string | null;
  books: Book | null;
};

const REFUND_STATUS_LABELS: Record<string, string> = {
  requested: "Refund requested",
  approved: "Refund approved",
  rejected: "Refund request rejected",
  refunded: "Refunded",
  cancelled: "Refund request cancelled",
};

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error, success } = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/library");
  }

  const { data: purchases } = await supabase
    .from("purchases")
    .select("book_id, amount_cents, created_at, refunded_at, stripe_payment_intent_id, books(*)")
    .eq("reader_id", user.id)
    .order("created_at", { ascending: false })
    .returns<PurchaseWithBook[]>();

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
    .select("id, stripe_payment_intent_id, total_amount_cents, fulfilled_at, refunded_at, items")
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

  const allPurchases = purchases ?? [];

  // Merges purchases rows AND fulfilled bundle snapshots into one entry
  // per actual paid transaction -- including a transaction with zero
  // purchases rows (every bundle item was already owned elsewhere), which
  // would otherwise be completely absent from this page. See
  // groupPurchasesByTransaction's own documentation for the full model.
  const transactionGroups = groupPurchasesByTransaction(allPurchases, bundleSnapshots ?? []);

  // Derived from the same deduplicated transaction model above, not
  // re-summed from raw purchases rows -- see calculateTotalSpentCents's
  // own documentation for why (avoids double-counting a normal bundle's
  // purchases rows against its snapshot, and now correctly includes a
  // zero-purchase-rows paid bundle transaction, which the original
  // purchases-only sum silently omitted).
  const totalSpentCents = calculateTotalSpentCents(transactionGroups);

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-3xl font-semibold">Your library</h1>
      <p className="mt-1 text-sm text-muted">
        Everything you&apos;ve bought, with purchase details.
      </p>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      {success && (
        <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{success}</p>
      )}

      {transactionGroups.length === 0 ? (
        <p className="mt-8 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          You haven&apos;t bought any books yet.
        </p>
      ) : (
        <>
          <p className="mt-6 text-sm text-muted">
            Total spent:{" "}
            <span className="font-semibold text-primary">
              ${(totalSpentCents / 100).toFixed(2)}
            </span>
          </p>

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
                      One purchase · {group.bookCount} books · $
                      {(group.totalAmountCents / 100).toFixed(2)}
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
                                · ${(purchase.amount_cents / 100).toFixed(2)}
                                {purchase.refunded_at && (
                                  <span className="ml-2 text-red-600">Refunded</span>
                                )}
                              </p>
                            </div>
                            {purchase.refunded_at ? (
                              <span className="text-xs text-muted">No longer available</span>
                            ) : (
                              <a
                                href={`/api/books/${purchase.book_id}/download`}
                                className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
                              >
                                Download EPUB
                              </a>
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
