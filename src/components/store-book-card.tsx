import Link from "next/link";
import { formatCatalogPriceLabel } from "@/lib/catalog-price";
import type { Book } from "@/lib/types";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { authorPagePath } from "@/lib/pen-names";
import { resolveOriginalAuthor } from "@/lib/book-byline";
import { AdultTag } from "@/components/adult-tag";
import { addToCartFromLibraria } from "@/app/(public)/shporta/actions";
import { starFills, type RatingSummary, type StoreCardAction } from "@/lib/libraria-store";

// LR1 (Renato 11-25, sketch r4 + LC1/LC2): Libraria's own card. Cover,
// title, author, gold stars with the review count (none without a
// review), the price and one small button. The shared BookCard stays
// as it is for every other page.
//
// The button (lr1-4 a, decisions 9 and "Merre falas"): "Shto" adds a
// paid live book to the cart and keeps the reader on Libraria; once it
// is in the cart it reads "Në shportë" and opens the cart. A visitor's
// "Shto" goes to log in first. A free book keeps the book page's
// "Merre falas", and a pre-order "Shiko librin"; both open the book page.
const SMALL_BUTTON =
  "focus-ring inline-flex min-h-9 shrink-0 items-center justify-center rounded-full border border-primary bg-surface px-4 text-sm font-semibold text-primary transition-colors hover:bg-surface-hover";

export function StoreBookCard({
  book,
  coverUrl,
  authorName,
  rating,
  action,
}: {
  book: Pick<Book, "id" | "title" | "price_all" | "pen_name_id" | "original_author" | "is_adult">;
  coverUrl: string | null;
  authorName: string | null;
  rating: RatingSummary | null;
  action: StoreCardAction;
}) {
  const href = `/libra/${book.id}`;
  return (
    <div className="flex h-full flex-col gap-1">
      <Link href={href} className="focus-ring group flex flex-col gap-3 rounded-[3px]">
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="aspect-[5/8] w-full rounded-[3px] object-contain object-bottom drop-shadow-[0_6px_14px_rgba(30,58,50,0.18)]"
          />
        ) : (
          <CoverPlaceholder
            title={book.title}
            authorName={authorName}
            className="aspect-[5/8] w-full rounded-[3px] shadow-[0_6px_14px_rgba(30,58,50,0.18)]"
          />
        )}
        <p className="font-serif text-[1.0625rem] leading-snug text-foreground group-hover:underline">
          {book.title}
          {book.is_adult && (
            <>
              {" "}
              <AdultTag />
            </>
          )}
        </p>
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

      {rating && <Stars rating={rating} />}

      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
        <span className={`text-sm font-bold ${book.price_all === 0 ? "text-[#2f6b4f]" : "text-foreground"}`}>
          {formatCatalogPriceLabel(book.price_all)}
        </span>
        <CardButton bookId={book.id} title={book.title} action={action} />
      </div>
    </div>
  );
}

function CardButton({ bookId, title, action }: { bookId: string; title: string; action: StoreCardAction }) {
  switch (action) {
    case "add":
      return (
        <form action={addToCartFromLibraria.bind(null, bookId)}>
          <button type="submit" aria-label={`Shto në shportë: ${title}`} className={SMALL_BUTTON}>
            Shto
          </button>
        </form>
      );
    case "login":
      return (
        <Link href="/login?next=/librari" aria-label={`Shto në shportë: ${title}`} className={SMALL_BUTTON}>
          Shto
        </Link>
      );
    case "in-cart":
      return (
        <Link href="/shporta" aria-label={`Në shportë: ${title}. Hap shportën`} className={SMALL_BUTTON}>
          Në shportë
        </Link>
      );
    case "free":
      return (
        <Link href={`/libra/${bookId}`} className={SMALL_BUTTON}>
          Merre falas
        </Link>
      );
    case "view":
      return (
        <Link href={`/libra/${bookId}`} className={SMALL_BUTTON}>
          Shiko librin
        </Link>
      );
  }
}

// Five gold stars filled to the nearest half, then "(count)". The
// screen-reader text says it in words.
function Stars({ rating }: { rating: RatingSummary }) {
  const fills = starFills(rating.average);
  const label = `${rating.average.toLocaleString("sq-AL", { maximumFractionDigits: 1 })} nga 5 yje, ${rating.count} ${rating.count === 1 ? "vlerësim" : "vlerësime"}`;
  return (
    <p className="flex items-center gap-1 text-[0.8125rem] text-muted">
      <span className="sr-only">{label}</span>
      <span aria-hidden="true" className="flex">
        {fills.map((fill, i) => (
          <span
            key={i}
            className={
              fill === "full"
                ? "text-[#d99a00]"
                : fill === "half"
                  ? "bg-[linear-gradient(90deg,#d99a00_50%,#d8d0be_50%)] bg-clip-text text-transparent"
                  : "text-[#d8d0be]"
            }
          >
            ★
          </span>
        ))}
      </span>
      <span aria-hidden="true">({rating.count})</span>
    </p>
  );
}
