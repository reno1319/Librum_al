import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { LibraryBookCard } from "@/components/library-book-card";
import { resolveBookByline } from "@/lib/book-byline";
import { buyerDownloadNote, readMyDownloadStates } from "@/lib/book-downloads";
import type { Metadata } from "next";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

export const metadata: Metadata = {
  title: "Biblioteka ime",
  description: "Librat që keni mbledhur në Librum.",
};

// LIBRUM 2.0 UI-9 / ACCOUNT-1: Library is now current-ownership/download
// access ONLY -- the Purchases & refunds transaction history that used
// to live below the owned-book grid has moved to its own route,
// /account/purchases (src/app/account/purchases/page.tsx), which reuses
// refund-logic.ts/refund-actions.ts/refund-request-form.tsx/
// cancel-refund-button.tsx unchanged. The purchases query and the
// user_owns_book() ownership loop below stay -- the owned-book grid
// still needs both -- but nothing about grouping transactions, "Total
// spent," or refund status/actions is fetched or rendered here anymore.
// LIBRUM 2.0 AUTHOR-1B / AUTHOR-1C: resolved via resolvePublicAuthorName().
// PEN-NAMES-1: the byline is the book's pen name, embedded from the
// public_pen_names view as `pen` (no account columns).
// PEN-NAMES-2: the book is embedded from public_books (aliased `books`),
// which shows a buyer the books they own with no account column.
type PurchaseWithBook = {
  book_id: string;
  books: (PublicBook & { pen: PenNameRef | null }) | null;
};

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { error: rawError, success: rawSuccess } = await searchParams;
  const error = pageErrorMessage(rawError);
  const success = pageSuccessMessage(rawSuccess);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/library");
  }

  const { data: purchases } = await supabase
    .from("purchases")
    .select("book_id, books:public_books(*, pen:public_pen_names(id, name))")
    .eq("reader_id", user.id)
    .returns<PurchaseWithBook[]>();

  const allPurchases = purchases ?? [];

  // LAUNCH-1 P1-7B: refunded_at alone is not sufficient to decide
  // whether a listed purchase is still actively owned -- a lost-disputed
  // purchase (migration 035) never sets refunded_at, so it must also
  // read as not-currently-owned here, exactly like the book detail and
  // bundle pages' own "owned" checks (both already routed through this
  // same RPC). One call per distinct purchases row -- purchases has
  // unique(book_id, reader_id), so this is exactly one call per book
  // actually listed on this page.
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

  // DOWNLOADS-1 (3a, 4a): the buyer's own download state, for the line
  // under each Download button.
  const downloadStates = await readMyDownloadStates(supabase);

  // The Library grid: every currently-owned book, as a flat list --
  // never grouped by bundle/transaction (that grouping lives entirely
  // at /account/purchases now). A refunded or lost-disputed purchase's
  // book_id simply isn't in ownedByBookId (or maps to false), so it's
  // naturally excluded here.
  const ownedBooks = allPurchases
    .filter((purchase) => purchase.books && ownedByBookId.get(purchase.book_id))
    .map((purchase) => purchase.books!)
    .sort((a, b) => a.title.localeCompare(b.title));

  return (
    <main className="page-container flex-1 pt-5 pb-10 sm:pt-10">
      <PageHeader title="Biblioteka ime" description="Librat që keni mbledhur në Librum." />

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

      {ownedBooks.length === 0 ? (
        <EmptyState
          className="mt-8"
          title="Biblioteka juaj është bosh."
          description="Librat që merrni në Librum do të shfaqen këtu."
          action={
            <Link href="/librari" className={buttonClasses("primary", "md")}>
              Shfletoni Librarinë
            </Link>
          }
        />
      ) : (
        <>
        {/* TRUST PACK (item 5, 1. a): one link above the grid, not one per card. */}
        <p className="mt-4 text-sm text-muted">
          Nuk e dini si ta hapni një libër në telefon ose në Kindle?{" "}
          <Link href="/ndihme/leximi" className="text-primary underline">
            Si ta lexoni librin tuaj
          </Link>
          .
        </p>
        <ul className="mt-8 grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-4">
          {ownedBooks.map((book) => {
            const coverUrl = book.cover_path
              ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
              : null;

            return (
              <LibraryBookCard
                key={book.id}
                bookId={book.id}
                title={book.title}
                coverUrl={coverUrl}
                penNameId={book.pen?.id ?? null}
                authorName={resolveBookByline(book)}
                isPublished={book.status === "published"}
                downloadable={ownedByBookId.get(book.id) ?? false}
                downloadNote={buyerDownloadNote(downloadStates.get(book.id))}
              />
            );
          })}
        </ul>
        </>
      )}
    </main>
  );
}
