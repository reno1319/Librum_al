import Link from "next/link";
import { formatCatalogPriceLabel } from "@/lib/catalog-price";
import type { Book } from "@/lib/types";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { authorPagePath } from "@/lib/pen-names";
import { resolveOriginalAuthor } from "@/lib/book-byline";
import { AdultTag } from "@/components/adult-tag";
import { isPreorder, preorderReleaseLabel, tiranaToday } from "@/lib/preorder-reader";

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
// REDESIGN STEP 3 (A2, "List sample 1"): a soft-shadowed cover, a thin
// serif title, the author, and the price in bold -- "Free" in a
// lighter green so it reads apart from a paid price. Same elements and
// links as before.
export function BookCard({
  book,
  coverUrl,
  authorName,
}: {
  // PEN-NAMES-1: the byline links to the book's pen name page, never to
  // the account (no author_id here).
  // BD3 patch 4: with an "Autori origjinal" the byline is that name,
  // which has no page on Librum, so it is plain text, not a link to the
  // uploader's pen name page.
  // Required (audit r1, L7): a caller whose select drops the column
  // fails to type-check instead of linking an original author's name.
  // BD15 P8 (Q1 a): is_adult drives the 18+ tag. Every caller selects
  // "*" from public_books (book-card.test.ts pins the tag).
  // BD16 P4 (D1): status and release_date drive the "Del më …" badge.
  // Optional: a caller without them shows no badge (buying a pre-order
  // is refused by the database either way); every page caller selects
  // "*" from public_books, so they have both.
  book: Pick<Book, "id" | "title" | "genre" | "price_all" | "pen_name_id" | "original_author" | "is_adult"> &
    { status?: string | null; release_date?: string | null };
  coverUrl: string | null;
  authorName?: string | null;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Link
        href={`/libra/${book.id}`}
        className="focus-ring group flex flex-col gap-3 rounded-[3px]"
      >
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="aspect-[2/3] w-full rounded-[3px] object-cover shadow-[0_6px_14px_rgba(30,58,50,0.18)] transition-[transform,box-shadow] duration-150 group-hover:-translate-y-0.5 group-hover:shadow-[0_10px_20px_rgba(30,58,50,0.24)] motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
          />
        ) : (
          <CoverPlaceholder
            title={book.title}
            authorName={authorName}
            className="aspect-[2/3] w-full rounded-[3px] shadow-[0_6px_14px_rgba(30,58,50,0.18)]"
          />
        )}
        <div>
          {(book.genre || book.is_adult) && (
            <span className="flex flex-wrap items-center gap-x-2">
              {book.genre && (
                <span className="text-xs uppercase tracking-wide text-muted">
                  {book.genre}
                </span>
              )}
              {book.is_adult && <AdultTag />}
            </span>
          )}
          <p className="font-serif text-[1.0625rem] leading-snug text-foreground group-hover:underline">
            {book.title}
          </p>
          {isPreorder(book) && (
            <span
              data-preorder-badge=""
              className="mt-1 inline-block rounded-[3px] border border-[#806510] bg-[#fbf6e8] px-1.5 text-xs leading-5 font-semibold text-[#5c480b]"
            >
              {preorderReleaseLabel(book.release_date, tiranaToday())}
            </span>
          )}
        </div>
      </Link>

      {authorName &&
        (book.pen_name_id && !resolveOriginalAuthor(book) ? (
          <Link
            href={authorPagePath(book.pen_name_id)}
            className="focus-ring w-fit rounded-sm text-[0.8125rem] text-muted hover:underline"
          >
            {authorName}
          </Link>
        ) : (
          <span className="w-fit text-[0.8125rem] text-muted">{authorName}</span>
        ))}

      <span
        className={`text-sm font-bold ${book.price_all === 0 ? "text-[#2f6b4f]" : "text-primary"}`}
      >
        {formatCatalogPriceLabel(book.price_all)}
      </span>
    </div>
  );
}
