import Link from "next/link";

// LIBRUM 2.0 UI-8: the Reader Library's card -- deliberately NOT the
// commerce-oriented BookCard (src/components/book-card.tsx). A Library
// card represents something already owned, not something for sale, so
// it drops every purchase-decision affordance (price, Buy, wishlist,
// rating) and adds the one thing an owned book actually needs here: a
// direct download. `downloadable` is passed in rather than decided by
// this component -- the Library page is the sole authority on
// entitlement (via user_owns_book()), and this card only ever renders
// for books the page has already confirmed are owned, so it should
// never need to make that call itself.
export function LibraryBookCard({
  bookId,
  title,
  coverUrl,
  authorId,
  authorName,
  isPublished,
  downloadable,
}: {
  bookId: string;
  title: string;
  coverUrl: string | null;
  authorId: string;
  authorName: string | null;
  isPublished: boolean;
  downloadable: boolean;
}) {
  return (
    <li className="flex flex-col gap-1.5">
      <Link
        href={`/books/${bookId}`}
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
        <p className="font-serif text-base font-semibold leading-snug">{title}</p>
      </Link>

      {authorName && (
        <Link
          href={`/authors/${authorId}`}
          className="focus-ring w-fit rounded-sm text-xs text-muted hover:underline"
        >
          by {authorName}
        </Link>
      )}

      {!isPublished && <p className="text-xs text-muted">Unavailable in Bookstore</p>}

      {downloadable && (
        <a
          href={`/api/books/${bookId}/download`}
          className="focus-ring mt-1 w-fit rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
        >
          Download EPUB
        </a>
      )}
    </li>
  );
}
