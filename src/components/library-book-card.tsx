import Link from "next/link";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { authorPagePath } from "@/lib/pen-names";

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
  penNameId,
  authorName,
  isPublished,
  downloadable,
  downloadNote = null,
}: {
  bookId: string;
  title: string;
  coverUrl: string | null;
  // PEN-NAMES-1: the book's pen name id (the byline links to its page).
  penNameId: string | null;
  authorName: string | null;
  isPublished: boolean;
  downloadable: boolean;
  // DOWNLOADS-1: the buyer's line under the button (the cancel warning
  // while the 14 days are open, else "Downloaded <date>"), decided by
  // the Library page.
  downloadNote?: string | null;
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
            loading="lazy"
            decoding="async"
            className="aspect-[2/3] w-full rounded-[3px] object-cover shadow-sm transition-[transform,box-shadow] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-md motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
          />
        ) : (
          <CoverPlaceholder
            title={title}
            authorName={authorName}
            className="aspect-[2/3] w-full rounded-[3px]"
          />
        )}
        <p className="font-serif text-base font-semibold leading-snug">{title}</p>
      </Link>

      {authorName &&
        (penNameId ? (
          <Link
            href={authorPagePath(penNameId)}
            className="focus-ring w-fit rounded-sm text-xs text-muted hover:underline"
          >
            nga {authorName}
          </Link>
        ) : (
          <span className="w-fit text-xs text-muted">nga {authorName}</span>
        ))}

      {!isPublished && <p className="text-xs text-muted">Nuk ofrohet në Librari</p>}

      {downloadable && (
        <a
          href={`/api/books/${bookId}/download`}
          className="focus-ring mt-1 w-fit rounded-control border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
        >
          Shkarkoni EPUB
        </a>
      )}
      {downloadable && downloadNote && <p className="text-xs text-muted">{downloadNote}</p>}
    </li>
  );
}
