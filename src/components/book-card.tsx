import Link from "next/link";
import { formatCatalogPriceLabel } from "@/lib/catalog-price";
import type { Book } from "@/lib/types";

// LIBRUM 2.0 UI-4: the shared reader-commerce card, used by the
// Bookstore grid, the author profile page, the wishlist page, and
// bundle detail's book list. Hierarchy is deliberately minimal --
// cover, title, author, price -- no description, rating, wishlist
// control, owned badge, or Buy button: the whole card links to book
// detail, which owns the actual purchase decision (UI-5).
//
// ALL-WIRING-2: the price is the book's own `price_all`, rendered
// through the one catalog label function -- lek, never a `$`, and never
// `price_cents`. A row with no authored ALL price reads "Price
// unavailable" rather than borrowing either the free or the paid
// wording; discovery surfaces exclude such rows from their queries
// entirely, so this label is what remains for the surfaces that keep
// showing a specific, already-chosen book (a bundle's contents, an
// author's own dashboard).
export function BookCard({
  book,
  coverUrl,
  authorName,
}: {
  book: Pick<Book, "id" | "title" | "genre" | "price_all" | "author_id">;
  coverUrl: string | null;
  authorName?: string | null;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Link
        href={`/books/${book.id}`}
        className="focus-ring group flex flex-col gap-3 rounded-sm"
      >
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            className="aspect-[2/3] w-full rounded-md object-cover shadow-sm transition-[transform,box-shadow] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-md motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
          />
        ) : (
          <div className="aspect-[2/3] w-full rounded-md bg-border" />
        )}
        <div>
          {book.genre && (
            <span className="text-xs uppercase tracking-wide text-muted">
              {book.genre}
            </span>
          )}
          <p className="font-serif text-base font-semibold leading-snug">
            {book.title}
          </p>
        </div>
      </Link>

      {authorName && (
        <Link
          href={`/authors/${book.author_id}`}
          className="focus-ring w-fit rounded-sm text-xs text-muted hover:underline"
        >
          {authorName}
        </Link>
      )}

      <span className="text-sm font-medium text-primary/80">
        {formatCatalogPriceLabel(book.price_all)}
      </span>
    </div>
  );
}
