import Link from "next/link";
import { formatPrice } from "@/lib/pricing";
import { deleteBook } from "@/app/dashboard/books/actions";
import { DeleteBookButton } from "@/app/dashboard/delete-book-button";
import { buttonClasses } from "@/components/ui/button";
import type { Book } from "@/lib/types";

// LIBRUM 2.0 UI-6: the operational (not reader-facing) book row shared
// between the Dashboard overview's "recent 5" and /dashboard/books'
// full list -- deliberately NOT the reader BookCard, which is
// commerce-shaped and inappropriate for author-management UI.
//
// LIBRUM 2.0 CLEANUP-1 (UI-7A): Publish/Unpublish were removed from
// this row. Publishing Studio (src/app/dashboard/books/[id]/edit/page.tsx)
// now owns those lifecycle decisions with proper context -- the
// readiness checklist and the payout-gate explanation -- that a bare
// row-level button can't show; duplicating them here risked a reader
// hitting Publish and getting an unexplained server-side failure. Only
// Delete stays in "More actions": unlike Publish/Unpublish it doesn't
// need that extra context (the confirmation dialog IS the context),
// and it's a fast, common cleanup action (e.g. deleting an accidental
// duplicate draft) that shouldn't require a trip into Edit's own
// Danger zone. Edit and View (published only) stay directly visible,
// same as before.
export function AuthorBookRow({
  book,
  coverUrl,
}: {
  book: Pick<Book, "id" | "title" | "status" | "price_cents">;
  coverUrl: string | null;
}) {
  return (
    <li className="flex flex-wrap items-center gap-4 py-4">
      {coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={coverUrl} alt="" className="h-16 w-11 shrink-0 rounded object-cover" />
      ) : (
        <div className="h-16 w-11 shrink-0 rounded bg-border" />
      )}

      <div className="min-w-32 flex-1">
        <p className="font-serif font-medium">{book.title}</p>
        <p className="text-sm text-muted">{book.status === "draft" ? "Draft" : "Published"}</p>
      </div>

      <span className="text-sm font-semibold text-primary">{formatPrice(book.price_cents)}</span>

      <div className="flex flex-wrap items-center gap-2">
        <Link href={`/dashboard/books/${book.id}/edit`} className={buttonClasses("outline", "sm")}>
          Edit
        </Link>

        {book.status === "published" && (
          <Link href={`/books/${book.id}`} className={buttonClasses("outline", "sm")}>
            View
          </Link>
        )}

        <details>
          <summary className="focus-ring cursor-pointer select-none rounded-sm px-2 py-1.5 text-sm text-muted hover:text-foreground">
            More actions
          </summary>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <form action={deleteBook.bind(null, book.id)}>
              <DeleteBookButton title={book.title} />
            </form>
          </div>
        </details>
      </div>
    </li>
  );
}
