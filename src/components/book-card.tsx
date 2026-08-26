import Link from "next/link";
import { formatPrice } from "@/lib/pricing";
import type { Book } from "@/lib/types";

// LIBRUM 2.0 UI-4: the shared reader-commerce card, used by the
// Bookstore grid, the author profile page, the wishlist page, and
// bundle detail's book list. Hierarchy is deliberately minimal --
// cover, title, author, price -- no description, rating, wishlist
// control, owned badge, or Buy button: the whole card links to book
// detail, which owns the actual purchase decision (UI-5).
export function BookCard({
  book,
  coverUrl,
  authorName,
}: {
  book: Pick<Book, "id" | "title" | "genre" | "price_cents" | "author_id">;
  coverUrl: string | null;
  authorName?: string | null;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Link
        href={`/books/${book.id}`}
        className="focus-ring group flex flex-col gap-2 rounded-sm"
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
          className="focus-ring w-fit rounded-sm text-sm text-muted hover:underline"
        >
          {authorName}
        </Link>
      )}

      <span className="text-sm font-semibold text-primary">
        {formatPrice(book.price_cents)}
      </span>
    </div>
  );
}
