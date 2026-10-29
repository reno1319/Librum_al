import Link from "next/link";
import { formatCatalogPriceLabel, resolveCatalogPriceState } from "@/lib/catalog-price";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { deleteBook } from "@/app/(public)/dashboard/books/actions";
import { DeleteBookButton } from "@/app/(public)/dashboard/delete-book-button";
import { buttonClasses } from "@/components/ui/button";
import type { Book } from "@/lib/types";
import { buildAuthorTakedownNoticeLines, type AuthorTakedownNotice } from "@/lib/takedown-reasons";
import { IN_REVIEW_LABEL, buildAuthorSentBackNoticeLines, type AuthorReviewNotice } from "@/lib/book-review-copy";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { DismissableDetails } from "@/components/dismissable-details";

// LIBRUM 2.0 UI-6: the operational (not reader-facing) book row shared
// between the Dashboard overview's book list and /dashboard/books'
// full list -- deliberately NOT the reader BookCard, which is
// commerce-shaped and inappropriate for author-management UI.
//
// LIBRUM 2.0 CLEANUP-1 (UI-7A): Publish/Unpublish were removed from
// this row. Publishing Studio (src/app/dashboard/books/[id]/edit/page.tsx)
// now owns those lifecycle decisions with proper context -- the
// readiness checklist and the payout-gate explanation -- that a bare
// row-level button can't show; duplicating them here risked a reader
// hitting Publish and getting an unexplained server-side failure. Only
// Delete stays in "More actions": unlike Publish/Unpublish it doesn't
// need that extra context (the confirmation dialog IS the context),
// and it's a fast, common cleanup action (e.g. deleting an accidental
// duplicate draft) that shouldn't require a trip into Edit's own
// Danger zone. Edit and View (published only) stay directly visible,
// same as before.
//
// ALL-WIRING-2: the price column shows the book's own `price_all` in
// lek. "Price unavailable" here is the author's own signal that this
// title has no ALL price yet -- which is why the dashboard keeps
// listing such rows rather than hiding them the way reader-facing
// discovery surfaces do: this is where the author goes to fix it.
//
// REDESIGN STEP 4 (A2 dashboard mockup): cover, title, a meta line
// ("Ebook · genre · Published <date>", or "Ebook · Draft"), a LIVE /
// DRAFT tag, price, and two optional extras the dashboard passes and
// /dashboard/books does not: `recentCopies` (last-30-days sales or
// downloads, Renato D2; null = not shown, e.g. a failed sales read) and
// `missing` (a draft's unfinished publish-checklist items, by the
// checklist's own labels). A draft's Edit link reads "Continue setup",
// as on the mockup; it goes to the same Edit page.
//
// ADMIN-2-TAKEDOWN (G, M4): `takedown` is the book's active Librum
// takedown, if any (read by the caller with the author's own session).
// A taken-down book shows a TAKEN DOWN tag and the notice -- date,
// reason, Librum's message, the bundles also unpublished, where to ask --
// instead of the draft's missing-items list, and its link reads "Edit"
// rather than "Continue setup": it can't be published until Librum
// allows it again.
//
// ADMIN-3-REVIEW (F, 4a): `review` is the book's review state from the
// author's own review rows (one Dashboard read, N9). A draft waiting
// for review shows an IN REVIEW tag (no timing promise) instead of
// DRAFT; a book Librum sent back shows the send-back notice -- date,
// reason, Librum's message, what to do, where to ask. The takedown
// notice keeps priority when both apply.
//
// PHONE PASS (D3, D4 / Renato 4a 5a): KDP-style, as on the A2 mockup.
// Every row, phone and desktop alike, shows Edit (or "Continue setup")
// and a 44px "···" button. The ··· opens a floating menu that closes on
// an outside tap, on Escape and (r2, audit N3) when focus leaves it
// (DismissableDetails closeOnFocusOut): Edit details,
// Change manuscript or cover, Change price (each a jump to that section
// of the Edit page), View in Bookstore and Unpublish (published books
// only), and Delete. Unpublish only links to the Edit page's Publishing
// box, where the existing button and its explanation are -- the
// CLEANUP-1 reasoning above still holds. The separate View button is
// gone: it is in the menu.
const TAG_CLASSES = "rounded-[3px] px-2 py-1 text-xs font-bold tracking-wide";
const MENU_ITEM_BASE = "focus-ring flex min-h-11 w-full items-center px-4 text-left text-sm font-medium hover:bg-surface-hover";
const MENU_ITEM_CLASSES = `${MENU_ITEM_BASE} text-foreground`;
// Red text on white, 6.6:1.
const MENU_DELETE_CLASSES = `${MENU_ITEM_BASE} text-[#b42318]`;

export function AuthorBookRow({
  book,
  coverUrl,
  recentCopies = null,
  missing = [],
  takedown = null,
  review = null,
}: {
  book: Pick<Book, "id" | "title" | "status" | "price_all" | "genre" | "published_at">;
  coverUrl: string | null;
  recentCopies?: number | null;
  missing?: string[];
  takedown?: AuthorTakedownNotice | null;
  review?: AuthorReviewNotice | null;
}) {
  const isDraft = book.status === "draft";
  const isTakenDown = takedown !== null;
  const isInReview = !isTakenDown && isDraft && review?.inReview === true;
  const sentBack = !isTakenDown && isDraft && !isInReview ? (review?.sentBack ?? null) : null;
  const priceLabel = formatCatalogPriceLabel(book.price_all);
  const isFree = resolveCatalogPriceState(book.price_all) === "free";

  const meta = isDraft
    ? "E-libër · Draft"
    : [
        "E-libër",
        book.genre,
        book.published_at ? `Publikuar më ${formatTimestampAsDate(book.published_at)}` : "I publikuar",
      ]
        .filter(Boolean)
        .join(" · ");

  const showRecent = !isDraft && recentCopies !== null;
  const recentNoun = isFree
    ? recentCopies === 1
      ? "shkarkim"
      : "shkarkime"
    : "shitje";

  return (
    <li className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-4 sm:px-5 sm:py-5">
      {coverUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={coverUrl}
          alt=""
          loading="lazy"
          decoding="async"
          className="h-[84px] w-14 shrink-0 rounded-[2px] object-cover shadow-sm sm:h-24 sm:w-16"
        />
      ) : (
        <CoverPlaceholder
          title={book.title}
          className="h-[84px] w-14 shrink-0 rounded-[2px] sm:h-24 sm:w-16"
        />
      )}

      <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-1">
        <p className="font-serif text-lg leading-snug text-foreground sm:text-xl">{book.title}</p>
        <p className="text-sm text-muted">{meta}</p>
        {/* Phone: price and the 30-day figure share one line, as on the
            phone mockup; from sm up they are their own columns. */}
        <p className="text-sm text-muted sm:hidden">
          {priceLabel}
          {showRecent && ` · ${recentCopies} ${recentNoun} (30 ditë)`}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {isTakenDown ? (
            <span className={`${TAG_CLASSES} bg-[#f6e3df] text-[#8e2a1e]`}>HEQUR NGA LIBRARIA</span>
          ) : isInReview ? (
            <span className={`${TAG_CLASSES} bg-[#fbf0d4] text-[#806510]`}>{IN_REVIEW_LABEL.toUpperCase()}</span>
          ) : isDraft ? (
            <span className={`${TAG_CLASSES} bg-reader-tint text-[#7a5a00]`}>DRAFT</span>
          ) : (
            <span className={`${TAG_CLASSES} bg-[#e1f0e7] text-[#1e5c3e]`}>I PUBLIKUAR</span>
          )}
          {!isTakenDown && !isInReview && isDraft && missing.length > 0 && (
            <span className="text-[0.8125rem] text-muted">{`Për t'u bërë: ${missing.join(" · ")}`}</span>
          )}
        </div>
        {takedown && (
          <div role="status" className="mt-2 flex flex-col gap-1 rounded-[3px] border-l-4 border-[#8e2a1e] bg-[#fbf3f1] px-3 py-2 text-sm text-foreground">
            {buildAuthorTakedownNoticeLines(takedown, formatTimestampAsDate).map((line, index) => (
              <p key={index} className={index === 0 ? "font-semibold" : "whitespace-pre-wrap break-words"}>
                {line}
              </p>
            ))}
          </div>
        )}
        {sentBack && (
          <div role="status" className="mt-2 flex flex-col gap-1 rounded-[3px] border-l-4 border-[#806510] bg-[#fbf6e8] px-3 py-2 text-sm text-foreground">
            {buildAuthorSentBackNoticeLines(sentBack, formatTimestampAsDate).map((line, index) => (
              <p key={index} className={index === 0 ? "font-semibold" : "whitespace-pre-wrap break-words"}>
                {line}
              </p>
            ))}
          </div>
        )}
      </div>

      <div className="hidden w-36 shrink-0 flex-col gap-0.5 sm:flex">
        <span className="text-xs uppercase tracking-wide text-muted">Çmimi</span>
        <span className="font-semibold text-foreground">{priceLabel}</span>
      </div>

      <div className="hidden w-36 shrink-0 flex-col gap-0.5 sm:flex">
        {showRecent && (
          <>
            <span className="text-xs uppercase tracking-wide text-muted">
              {isFree ? "Shkarkime" : "Shitje"} (30 ditë)
            </span>
            <span className="font-semibold text-foreground">{recentCopies}</span>
          </>
        )}
      </div>

      <div className="relative flex w-full flex-wrap items-center gap-2 sm:w-auto">
        {isDraft && !isTakenDown && !isInReview ? (
          <Link
            href={`/dashboard/books/${book.id}/edit`}
            className="focus-ring inline-flex min-h-11 items-center justify-center rounded-[3px] bg-accent px-4 text-sm font-bold text-accent-foreground transition-colors hover:bg-[#c9a42c]"
          >
            Vazhdoni përgatitjen
          </Link>
        ) : (
          <Link
            href={`/dashboard/books/${book.id}/edit`}
            className={buttonClasses("outline", "sm", "min-h-11 rounded-[3px] border-[#c9c0ae] px-4 font-semibold")}
          >
            Ndryshoni
          </Link>
        )}

        <DismissableDetails className="sm:relative" closeOnFocusOut>
          <summary
            aria-label={`Më shumë veprime për ${book.title}`}
            className="focus-ring flex size-11 cursor-pointer list-none items-center justify-center rounded-[3px] border border-[#c9c0ae] bg-surface text-base font-bold text-foreground select-none hover:bg-surface-hover [&::-webkit-details-marker]:hidden"
          >
            <span aria-hidden="true">···</span>
          </summary>
          {/* Phone: the buttons have a full-width line of their own, and
              the menu opens under it from the left edge, so it never runs
              off the screen however wide "Vazhdoni përgatitjen" is. From sm up
              they end the row and it opens leftwards under the ···. */}
          <div className="absolute left-0 top-full z-10 mt-1 w-60 sm:left-auto sm:right-0 rounded-[3px] border border-border bg-surface py-1 shadow-md">
            <ul>
              <li>
                <Link href={`/dashboard/books/${book.id}/edit#details`} className={MENU_ITEM_CLASSES}>
                  Ndryshoni të dhënat
                </Link>
              </li>
              <li>
                <Link href={`/dashboard/books/${book.id}/edit#files`} className={MENU_ITEM_CLASSES}>
                  Ndryshoni dorëshkrimin ose kopertinën
                </Link>
              </li>
              <li>
                <Link href={`/dashboard/books/${book.id}/edit#pricing`} className={MENU_ITEM_CLASSES}>
                  Ndryshoni çmimin
                </Link>
              </li>
              {/* PREVIEW-1 (A5, Renato 6a): before it's live (draft, in
                  review, sent back, taken down), the book's own page is
                  the author's preview of it. */}
              {book.status !== "published" && (
                <li>
                  <Link href={`/libra/${book.id}`} className={MENU_ITEM_CLASSES}>
                    Shikoni librin para botimit
                  </Link>
                </li>
              )}
              {book.status === "published" && (
                <>
                  <li>
                    <Link href={`/libra/${book.id}`} className={MENU_ITEM_CLASSES}>
                      Shikojeni në Librari
                    </Link>
                  </li>
                  <li>
                    <Link href={`/dashboard/books/${book.id}/edit#publishing`} className={MENU_ITEM_CLASSES}>
                      Hiqeni nga publikimi
                    </Link>
                  </li>
                </>
              )}
              <li className="mt-1 border-t border-border pt-1">
                <form action={deleteBook.bind(null, book.id)}>
                  <DeleteBookButton title={book.title} className={MENU_DELETE_CLASSES} />
                </form>
              </li>
            </ul>
          </div>
        </DismissableDetails>
      </div>
    </li>
  );
}
