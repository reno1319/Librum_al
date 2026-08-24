import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { platformFeeCents } from "@/lib/pricing";
import { collectDistinctPaymentIntentIds, excludeLostDisputedRows } from "./revenue-logic";
import type { Book } from "@/lib/types";

const CHART_DAYS = 14;

type Purchase = {
  book_id: string;
  amount_cents: number;
  created_at: string;
  stripe_checkout_session_id: string;
  stripe_payment_intent_id: string | null;
};

// A fulfilled, non-refunded bundle snapshot whose Stripe Checkout Session
// isn't represented by any of this author's own purchases rows -- i.e. a
// snapshot bundle payment where every item turned out to already be
// actively owned through some unrelated transaction (see the Phase 9B-2
// zero-eligible-item accounting fix). Real revenue with zero new book
// entitlements to attribute it to -- purchases alone would under-report
// this author's actual revenue by exactly this amount.
type BundleSnapshotRevenue = {
  stripe_checkout_session_id: string | null;
  stripe_payment_intent_id: string | null;
  total_amount_cents: number | null;
  fulfilled_at: string;
};

function netCents(amountCents: number) {
  return amountCents - platformFeeCents(amountCents);
}

export default async function SalesPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: books } = await supabase
    .from("books")
    .select("id, title, status")
    .eq("author_id", user!.id)
    .returns<Pick<Book, "id" | "title" | "status">[]>();

  const bookIds = (books ?? []).map((book) => book.id);

  const { data: purchases } =
    bookIds.length > 0
      ? await supabase
          .from("purchases")
          .select(
            "book_id, amount_cents, created_at, stripe_checkout_session_id, stripe_payment_intent_id",
          )
          .in("book_id", bookIds)
          .is("refunded_at", null)
          .returns<Purchase[]>()
      : { data: [] as Purchase[] };

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
    .select("stripe_checkout_session_id, stripe_payment_intent_id, total_amount_cents, fulfilled_at")
    .eq("author_id", user!.id)
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

  const rawPurchases = purchases ?? [];
  const rawSnapshots = snapshots ?? [];
  const allViews = views ?? [];

  // LAUNCH-1 P1-8: a lost-disputed purchase must not be represented as
  // active author revenue -- refunded_at alone (the filter already
  // applied to both queries above) never covers this, since a dispute
  // never sets refunded_at. One batched RPC call, not one per row (this
  // page can have hundreds/thousands of purchases rows for a successful
  // author, unlike the Library/bundle pages' own per-book
  // user_owns_book() checks, which are bounded by a single reader's own
  // purchase count) -- collects the distinct payment-intent id set from
  // BOTH purchases and snapshots (a bundle's purchases rows and its own
  // snapshot row always share one payment intent -- see the P1-7A/P1-8
  // audits), then excludes any row whose payment intent comes back, so
  // a disputed bundle transaction is excluded consistently across both
  // representations, not just one.
  const candidatePaymentIntentIds = collectDistinctPaymentIntentIds(rawPurchases, rawSnapshots);

  const lostDisputedPaymentIntentIds = new Set<string>();
  if (candidatePaymentIntentIds.length > 0) {
    const { data: lostDisputed } = await supabase.rpc("lost_disputed_payment_intents", {
      target_payment_intent_ids: candidatePaymentIntentIds,
    });
    for (const row of (lostDisputed ?? []) as { stripe_payment_intent_id: string }[]) {
      lostDisputedPaymentIntentIds.add(row.stripe_payment_intent_id);
    }
  }

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
  const purchasedSessionIds = new Set(
    allPurchases.map((p) => p.stripe_checkout_session_id),
  );
  const transactionOnlySnapshots = filteredSnapshots.filter(
    (snapshot) =>
      snapshot.stripe_checkout_session_id !== null &&
      !purchasedSessionIds.has(snapshot.stripe_checkout_session_id),
  );

  // "Units" means books acquired -- one purchases row per book per
  // reader (see the `purchases` table's own unique(book_id, reader_id)
  // constraint and this page's per-book breakdown below, both keyed on
  // book_id). A transaction-only snapshot has no purchases row and
  // therefore no book to count -- it must NOT increment Units, and
  // doesn't: totalUnitsSold is computed from allPurchases alone, exactly
  // as before this change.
  const totalUnitsSold = allPurchases.length;
  const totalViews = allViews.length;
  const totalNetCents =
    allPurchases.reduce((sum, p) => sum + netCents(p.amount_cents), 0) +
    transactionOnlySnapshots.reduce(
      (sum, snapshot) => sum + netCents(snapshot.total_amount_cents ?? 0),
      0,
    );
  const publishedCount =
    books?.filter((book) => book.status === "published").length ?? 0;

  const perBook = (books ?? []).map((book) => {
    const bookPurchases = allPurchases.filter((p) => p.book_id === book.id);
    const bookViews = allViews.filter((v) => v.book_id === book.id).length;
    return {
      id: book.id,
      title: book.title,
      unitsSold: bookPurchases.length,
      views: bookViews,
      netCents: bookPurchases.reduce((sum, p) => sum + netCents(p.amount_cents), 0),
    };
  });
  perBook.sort((a, b) => b.netCents - a.netCents);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = Array.from({ length: CHART_DAYS }, (_, i) => {
    const date = new Date(today);
    date.setDate(date.getDate() - (CHART_DAYS - 1 - i));
    return { date, cents: 0 };
  });

  for (const purchase of allPurchases) {
    const purchaseDate = new Date(purchase.created_at);
    purchaseDate.setHours(0, 0, 0, 0);
    const bucket = days.find((d) => d.date.getTime() === purchaseDate.getTime());
    if (bucket) bucket.cents += netCents(purchase.amount_cents);
  }

  // Bucketed by fulfilled_at, not created_at: fulfilled_at is set
  // atomically by the webhook at the moment Stripe confirms this
  // transaction was actually paid (the same moment a normal purchase's
  // own created_at is written), while created_at on a snapshot is
  // checkout-START time -- when the reader clicked "Buy," potentially
  // hours or days before payment, sometimes on an entirely different
  // calendar day. Revenue recognition belongs on the day payment
  // completed. Only transactionOnlySnapshots are added here --
  // normal/partial-ownership snapshots are excluded by the same
  // session-id membership check used for Net revenue above, so their
  // revenue (already charted via the purchases loop) is never counted
  // twice in this same daily series.
  for (const snapshot of transactionOnlySnapshots) {
    const snapshotDate = new Date(snapshot.fulfilled_at);
    snapshotDate.setHours(0, 0, 0, 0);
    const bucket = days.find((d) => d.date.getTime() === snapshotDate.getTime());
    if (bucket) bucket.cents += netCents(snapshot.total_amount_cents ?? 0);
  }

  const maxCents = Math.max(1, ...days.map((d) => d.cents));

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/dashboard" className="text-sm text-muted hover:underline">
        &larr; Back to dashboard
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Sales</h1>
      <p className="mt-1 text-sm text-muted">
        Your net revenue, after Librum&apos;s platform fee.
      </p>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-sm text-muted">Net revenue</p>
          <p className="mt-1 font-serif text-2xl font-semibold text-primary">
            ${(totalNetCents / 100).toFixed(2)}
          </p>
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
      <div
        className="mt-4 rounded-lg border border-border bg-surface p-4 shadow-sm"
        style={{ display: "flex", alignItems: "flex-end", height: "8rem", gap: "6px" }}
      >
        {days.map((day) => (
          <div
            key={day.date.toISOString()}
            style={{
              display: "flex",
              flex: "1 1 0%",
              height: "100%",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: "4px",
            }}
            title={`${day.date.toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
            })}: $${(day.cents / 100).toFixed(2)}`}
          >
            <div
              className="w-full rounded-t bg-primary"
              style={{
                height: `${Math.max(2, (day.cents / maxCents) * 100)}%`,
              }}
            />
            <span className="text-[10px] text-muted">
              {day.date.getDate()}
            </span>
          </div>
        ))}
      </div>

      <h2 className="mt-10 font-serif text-xl font-semibold">
        By book
      </h2>
      {perBook.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-border px-6 py-16 text-center text-muted">
          No books yet.
        </p>
      ) : (
        <ul className="mt-4 divide-y divide-border">
          {perBook.map((book) => (
            <li
              key={book.id}
              className="flex flex-wrap items-center justify-between gap-2 py-3"
            >
              <span className="font-serif font-medium">{book.title}</span>
              <span className="text-sm text-muted">
                {book.views} view{book.views === 1 ? "" : "s"}
              </span>
              <span className="text-sm text-muted">
                {book.unitsSold} unit{book.unitsSold === 1 ? "" : "s"}
              </span>
              <span className="text-sm font-semibold text-primary">
                ${(book.netCents / 100).toFixed(2)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
