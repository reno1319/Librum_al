import Link from "next/link";
import { formatCatalogPriceLabel } from "@/lib/catalog-price";
import type { Book } from "@/lib/types";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { authorPagePath } from "@/lib/pen-names";
import { resolveOriginalAuthor } from "@/lib/book-byline";
import { AdultTag } from "@/components/adult-tag";
import { Stars } from "@/components/store-book-card";
import { isPreorder, preorderReleaseLabel, tiranaToday } from "@/lib/preorder-reader";
import type { RatingSummary } from "@/lib/libraria-store";

// Amazon book page, patch 2 (design r7): a card of the shelf under the
// book. Cover (with "I ri" for a book new on Librum, item 20), title,
// author, gold stars with the count (item 12; none without a review)
// and the price. No button: the card opens the book. Only the book page
// uses it; BookCard and Libraria's card are unchanged.
export function BookPageCard({
  book,
  coverUrl,
  authorName,
  rating,
  isNew,
}: {
  book: Pick<Book, "id" | "title" | "price_all" | "pen_name_id" | "original_author" | "is_adult"> & {
    status?: string | null;
    release_date?: string | null;
  };
  coverUrl: string | null;
  authorName: string | null;
  rating: RatingSummary | null;
  isNew: boolean;
}) {
  return (
    <div data-book-page-card="" className="flex w-full flex-col gap-0.5">
      <Link href={`/libra/${book.id}`} className="focus-ring group flex flex-col gap-2 rounded-[3px]">
        <span className="relative block">
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coverUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="aspect-[5/8] w-full rounded-[3px] object-contain object-bottom drop-shadow-[0_2px_6px_rgba(0,0,0,0.18)]"
            />
          ) : (
            <CoverPlaceholder
              title={book.title}
              authorName={authorName}
              className="aspect-[5/8] w-full rounded-[3px] shadow-[0_2px_6px_rgba(0,0,0,0.18)]"
            />
          )}
          {isNew && (
            <span
              data-new-tag=""
              className="absolute top-0 left-0 z-[1] rounded-tl-[3px] rounded-br-[3px] bg-primary px-[0.4375rem] py-[0.1875rem] text-[0.6875rem] leading-none font-bold text-[#f3df9a]"
            >
              I ri
            </span>
          )}
        </span>
        <span className="text-sm leading-5 text-foreground group-hover:underline">
          {book.title}
          {book.is_adult && (
            <>
              {" "}
              <AdultTag />
            </>
          )}
        </span>
      </Link>
      {isPreorder(book) && (
        <span
          data-preorder-badge=""
          className="w-fit rounded-[3px] border border-[#806510] bg-[#fbf6e8] px-1.5 text-xs leading-5 font-semibold text-[#5c480b]"
        >
          {preorderReleaseLabel(book.release_date ?? null, tiranaToday())}
        </span>
      )}
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
      {rating && <Stars rating={rating} />}
      <span className={`text-base ${book.price_all === 0 ? "text-[#2f6b4f]" : "text-foreground"}`}>
        {formatCatalogPriceLabel(book.price_all)}
      </span>
    </div>
  );
}
