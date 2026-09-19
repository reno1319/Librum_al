import type { Book } from "@/lib/types";

// LIBRUM 2.0 UI-6: the Dashboard's single prioritized "what should I do
// next" decision, extracted as a pure function -- same "extract a pure
// decision function, unit-test it directly" pattern already used by
// src/lib/homepage.ts's resolveHomepageCta(), src/lib/bookstore.ts's
// parseBookstoreQuery(), and src/lib/book-purchase.ts's
// resolveBookPurchaseState(). Priority, highest first: zero books (the
// EmptyState itself becomes the next-action experience, so the page
// renders nothing else once this is the result) > continuing the most
// recent draft > paid publishing being unavailable for a priced book >
// no action needed. Deliberately never stacks more than one -- the whole
// point is ONE prioritized thing to do, not a wall of alerts.
//
// PR-G ordering decision, and the reason it changed: the
// paid-publishing slot used to sit ABOVE continue-draft, keyed on
// profiles.stripe_payouts_enabled, and in practice that permanently hid
// the continue-draft prompt from every author with a priced book.
//
// Why that flag stopped being a valid input, stated accurately rather
// than overstated: creation of new Stripe Connect accounts is disabled
// (connectStripeAccount, dashboard/payouts/actions.ts), but the flag was
// never unsettable -- a pre-existing connected account and the
// account.updated webhook (processAccountUpdatedEvent) could still have
// made it true. It is provider-specific author-payout state, and that is
// not a valid paid-publishing permission whatever its value.
//
// An actionable prompt now outranks an informational one. "Your draft is
// waiting" is something the author can act on today; "paid publishing
// hasn't launched" is something only Librum can change, so it fills the
// slot only when there is no draft action to offer.
export type DashboardAttentionState =
  | { kind: "zero-books" }
  | { kind: "continue-draft"; book: Pick<Book, "id" | "title"> }
  | { kind: "paid-publishing-unavailable" }
  | { kind: "none" };

type AttentionBook = Pick<Book, "id" | "title" | "status" | "price_cents" | "created_at">;

export function resolveDashboardAttention(params: {
  books: AttentionBook[];
  paidPublishingAvailable: boolean;
}): DashboardAttentionState {
  const { books, paidPublishingAvailable } = params;

  if (books.length === 0) {
    return { kind: "zero-books" };
  }

  // An actionable prompt outranks an informational one -- see the
  // ordering note on DashboardAttentionState above.
  const drafts = books.filter((book) => book.status === "draft");
  if (drafts.length > 0) {
    const mostRecentDraft = drafts.reduce((latest, book) =>
      new Date(book.created_at).getTime() > new Date(latest.created_at).getTime()
        ? book
        : latest,
    );
    return {
      kind: "continue-draft",
      book: { id: mostRecentDraft.id, title: mostRecentDraft.title },
    };
  }

  // Mirrors performPublish()'s own real gate exactly (books/actions.ts):
  // paid publishing only blocks a book priced above 0 -- a free-book-only
  // author never sees this, since it wouldn't actually be true for them.
  if (!paidPublishingAvailable && books.some((book) => book.price_cents > 0)) {
    return { kind: "paid-publishing-unavailable" };
  }

  return { kind: "none" };
}
