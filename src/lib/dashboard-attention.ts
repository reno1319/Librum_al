import type { Book } from "@/lib/types";

// LIBRUM 2.0 UI-6: the Dashboard's single prioritized "what should I do
// next" decision, extracted as a pure function -- same "extract a pure
// decision function, unit-test it directly" pattern already used by
// src/lib/homepage.ts's resolveHomepageCta(), src/lib/bookstore.ts's
// parseBookstoreQuery(), and src/lib/book-purchase.ts's
// resolveBookPurchaseState(). Priority, highest first: zero books (the
// EmptyState itself becomes the next-action experience, so the page
// renders nothing else once this is the result) > payout setup blocking
// a paid book from publishing > continuing the most recent draft > no
// action needed. Deliberately never stacks more than one -- the whole
// point is ONE prioritized thing to do, not a wall of alerts.
export type DashboardAttentionState =
  | { kind: "zero-books" }
  | { kind: "payout-setup" }
  | { kind: "continue-draft"; book: Pick<Book, "id" | "title"> }
  | { kind: "none" };

type AttentionBook = Pick<Book, "id" | "title" | "status" | "price_cents" | "created_at">;

export function resolveDashboardAttention(params: {
  books: AttentionBook[];
  payoutsEnabled: boolean;
}): DashboardAttentionState {
  const { books, payoutsEnabled } = params;

  if (books.length === 0) {
    return { kind: "zero-books" };
  }

  // Mirrors publishBook()'s own real gate exactly (books/actions.ts):
  // payout setup only blocks a book priced above $0 -- a free-book-only
  // author never sees this, since it wouldn't actually be true for them.
  if (!payoutsEnabled && books.some((book) => book.price_cents > 0)) {
    return { kind: "payout-setup" };
  }

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

  return { kind: "none" };
}
