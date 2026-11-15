import Link from "next/link";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { authorPagePath } from "@/lib/pen-names";
import { BookSampleReader } from "@/components/book-sample-reader";
import { DOWNLOAD_CANCEL_WARNING } from "@/lib/book-downloads";
import { progressLabel } from "@/lib/reader-anchors";

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
  progress = null,
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
  // K8 (Renato 11-15): how much of the book the buyer has read in the
  // online reader, on any device (0..1); null = not started. Pictures r1:
  // the bar and "N% e lexuar" only, no highlight count.
  progress?: number | null;
}) {
  return (
    <li className="flex flex-col gap-1.5">
      <Link
        href={`/libra/${bookId}`}
        className="focus-ring group flex flex-col gap-3 rounded-sm"
      >
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            loading="lazy"
            decoding="async"
            className="aspect-[5/8] w-full rounded-[3px] object-contain object-bottom drop-shadow-sm transition-[transform,filter] duration-150 group-hover:-translate-y-0.5 group-hover:drop-shadow-md motion-reduce:transition-none motion-reduce:group-hover:translate-y-0"
          />
        ) : (
          <CoverPlaceholder
            title={title}
            authorName={authorName}
            className="aspect-[5/8] w-full rounded-[3px]"
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

      {progress !== null && progress > 0 && (
        <div className="mt-0.5 flex flex-col gap-1">
          <div
            className="h-1 w-full overflow-hidden rounded-full bg-border"
            role="progressbar"
            aria-label="Sa keni lexuar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
          >
            <div className="h-full rounded-full bg-[#c0841a]" style={{ width: `${Math.max(2, Math.round(progress * 100))}%` }} />
          </div>
          <p className="text-xs tabular-nums text-muted">{progressLabel(progress)}</p>
        </div>
      )}

      {downloadable && (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <BookSampleReader
            bookId={bookId}
            bookTitle={title}
            mode="owned"
            label="Lexo"
            coverUrl={coverUrl}
            confirmFirst={downloadNote === DOWNLOAD_CANCEL_WARNING}
            triggerClassName="focus-ring min-h-9 rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          />
          <a
            href={`/api/books/${bookId}/download`}
            className="focus-ring min-h-9 rounded-full border border-border px-3 py-1.5 text-sm hover:bg-surface-hover"
          >
            Shkarko EPUB
          </a>
        </div>
      )}
      {downloadable && downloadNote && <p className="text-xs text-muted">{downloadNote}</p>}
    </li>
  );
}
