import Link from "next/link";
import { formatPrice } from "@/lib/pricing";
import { publishBook, unpublishBook, deleteBook } from "@/app/dashboard/books/actions";
import { DeleteBookButton } from "@/app/dashboard/delete-book-button";
import { buttonClasses } from "@/components/ui/button";
import type { Book } from "@/lib/types";

// LIBRUM 2.0 UI-6: the operational (not reader-facing) book row shared
// between the Dashboard overview's "recent 5" and /dashboard/books'
// full list -- deliberately NOT the reader BookCard, which is
// commerce-shaped and inappropriate for author-management UI.
//
// Publish/Unpublish/Delete stay reachable from this row rather than
// moving to the book-edit page, per the UI-6 implementation's own
// binding rule: src/app/dashboard/books/[id]/edit/page.tsx was
// inspected and exposes none of the three (only "Save changes" and
// Contributors add/remove) -- removing them from here without an
// approved place for them to live instead would be a real feature
// regression, not a simplification. This pre-commit correction tucks
// them into a native <details> "More actions" disclosure instead of
// leaving all 4-5 actions directly on the row, which just reproduced
// the original action-wall problem UI-6 was meant to reduce -- same
// forms, same server actions, same DeleteBookButton, purely a
// presentation change. Edit and View (published only) stay directly
// visible since those are the two actions the UI-6 design settled on
// as row-level defaults.
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
            {book.status === "draft" ? (
              <form action={publishBook.bind(null, book.id)}>
                <button type="submit" className={buttonClasses("outline", "sm")}>
                  Publish
                </button>
              </form>
            ) : (
              <form action={unpublishBook.bind(null, book.id)}>
                <button type="submit" className={buttonClasses("outline", "sm")}>
                  Unpublish
                </button>
              </form>
            )}

            <form action={deleteBook.bind(null, book.id)}>
              <DeleteBookButton title={book.title} />
            </form>
          </div>
        </details>
      </div>
    </li>
  );
}
