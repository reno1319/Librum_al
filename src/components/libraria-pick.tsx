import Link from "next/link";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { CardButton, Stars } from "@/components/store-book-card";
import { formatCatalogPriceLabel } from "@/lib/catalog-price";
import { authorPagePath } from "@/lib/pen-names";
import { resolveOriginalAuthor } from "@/lib/book-byline";
import type { RatingSummary, StoreCardAction } from "@/lib/libraria-store";
import type { QuoteFrom } from "@/lib/libraria-picks";
import type { Book } from "@/lib/types";

// LR1 patch 4 (sketch r4, lb2 a, lb6 a, lb8 a): the "Çfarë po lexojmë"
// box. Three parts on a computer: the cover on yellow; the badge, title,
// "nga <author> (Autor)", stars, the staff note, the price and the
// card's own button; the quote on green with who said it. On a phone
// the three parts stack. Used on Libraria (the newest pick) and on the
// "Më shumë" page (every pick, lr4-2 a). An 18+ book may be the pick,
// and the box shows no 18+ tag (lr4-5 b, as the banner, lr3-10).
export type PickBoxData = {
  book: Pick<Book, "id" | "title" | "price_all" | "pen_name_id" | "original_author">;
  coverUrl: string | null;
  authorName: string | null;
  rating: RatingSummary | null;
  action: StoreCardAction;
  badge: string | null;
  note: string;
  quote: string;
  quoteFrom: QuoteFrom;
};

export function LibrariaPickBox({ pick, headingLevel = 3 }: { pick: PickBoxData; headingLevel?: 2 | 3 }) {
  const { book, coverUrl, authorName } = pick;
  const href = `/libra/${book.id}`;
  const Title = headingLevel === 2 ? "h2" : "h3";
  return (
    <article className="grid overflow-hidden rounded-[3px] border border-[#d9cdb0] bg-[#fbf6ea] lg:grid-cols-[26%_1fr_30%]">
      <div className="flex items-center justify-center bg-[#f3e1a8] px-6 py-7 lg:py-11">
        <Link href={href} tabIndex={-1} aria-hidden="true" className="block w-[8.75rem] lg:w-[11.875rem]">
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coverUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="aspect-[5/8] w-full rounded-[2px] object-contain object-bottom drop-shadow-[0_10px_24px_rgba(0,0,0,0.3)]"
            />
          ) : (
            <CoverPlaceholder
              title={book.title}
              authorName={authorName}
              className="aspect-[5/8] w-full rounded-[2px] shadow-[0_10px_24px_rgba(0,0,0,0.3)]"
            />
          )}
        </Link>
      </div>

      <div className="flex flex-col gap-3 px-5 py-6 sm:px-8 lg:py-11">
        {pick.badge && (
          <span className="w-fit rounded-[3px] bg-primary px-2.5 py-1 text-[0.8125rem] font-semibold text-primary-foreground">
            {pick.badge}
          </span>
        )}
        <Title className="font-serif text-[1.75rem] leading-tight font-normal text-foreground sm:text-[2.25rem]">
          <Link href={href} className="focus-ring rounded-sm hover:underline">
            {book.title}
          </Link>
        </Title>
        {authorName && (
          <p className="text-base text-muted">
            nga{" "}
            {book.pen_name_id && !resolveOriginalAuthor(book) ? (
              <Link
                href={authorPagePath(book.pen_name_id)}
                className="focus-ring rounded-sm underline underline-offset-2 hover:decoration-2"
              >
                {authorName}
              </Link>
            ) : (
              authorName
            )}{" "}
            (Autor)
          </p>
        )}
        {pick.rating && <Stars rating={pick.rating} />}
        <p className="text-[1rem] leading-relaxed text-foreground">{pick.note}</p>
        <div className="mt-1 flex flex-wrap items-center gap-4">
          <span className={`text-2xl font-bold ${book.price_all === 0 ? "text-[#2f6b4f]" : "text-foreground"}`}>
            {formatCatalogPriceLabel(book.price_all)}
          </span>
          <CardButton bookId={book.id} title={book.title} action={pick.action} />
        </div>
      </div>

      <figure className="flex flex-col justify-center bg-[#1f3d33] px-6 py-7 text-[#f7f3ea] sm:px-10 lg:py-11">
        <span aria-hidden="true" className="font-serif text-[3.5rem] leading-none text-[#d4af37]">
          “
        </span>
        <blockquote className="mt-1 font-serif text-[1.25rem] leading-snug italic sm:text-[1.5rem]">
          {pick.quote}
        </blockquote>
        <figcaption className="mt-5 flex flex-col gap-1">
          <span aria-hidden="true" className="block h-0.5 w-10 bg-[#d4af37]" />
          <span className="mt-3 font-semibold">{authorName}</span>
          <span className="text-sm text-[#cfd8d2]">
            {pick.quoteFrom === "book" ? (
              <>
                nga <i>{book.title}</i>
              </>
            ) : (
              "autori i librit"
            )}
          </span>
        </figcaption>
      </figure>
    </article>
  );
}
