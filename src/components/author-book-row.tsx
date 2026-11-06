import Link from "next/link";
import { formatCatalogPriceLabel, resolveCatalogPriceState } from "@/lib/catalog-price";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { deleteBook } from "@/app/(public)/dashboard/books/actions";
import { DeleteBookButton } from "@/app/(public)/dashboard/delete-book-button";
import { buttonClasses } from "@/components/ui/button";
import type { Book } from "@/lib/types";
import { buildAuthorTakedownNoticeLines, type AuthorTakedownNotice } from "@/lib/takedown-reasons";
import { buildAuthorSentBackNoticeLines, type AuthorReviewNotice } from "@/lib/book-review-copy";
import {
  isLiveState,
  isPreorderState,
  shelfStateCopy,
  resolveShelfState,
  shelfMenuItems,
  type ShelfMenuItem,
  type ShelfState,
} from "@/lib/bookshelf";
import { isPickedPdEdition, pdShelfLine } from "@/lib/pd-editions";
import { BOOK_ACTIONS_ID, editorPath } from "@/lib/book-editor-copy";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { formatReleaseDay, preorderFileDueDate, waitingReadersLine } from "@/lib/preorders";
import { DismissableDetails } from "@/components/dismissable-details";

// LIBRUM 2.0 UI-6: the operational (not reader-facing) book row shared
// between the Dashboard overview's book list and /dashboard/books'
// full list -- deliberately NOT the reader BookCard, which is
// commerce-shaped and inappropriate for author-management UI.
//
// LIBRUM 2.0 CLEANUP-1 (UI-7A): Publish/Unpublish were removed from
// this row. The book editor (src/app/(public)/dashboard/books/[id]/editor/page.tsx)
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
// as on the mockup; it goes to the same book editor.
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
// Change manuscript or cover, Change price (each the editor's matching
// tab), View in Bookstore and Unpublish (published books only), and
// Delete. Unpublish only links to the editor's Veprime box (BD15
// P5b-3a), where the button and its explanation are -- the CLEANUP-1
// reasoning above still holds. The separate View button is gone: it is
// in the menu.
//
// BD15 P6 (bookshelf, PLAN-BD15-r1 §2.1): the row is now a shelf card.
// Its state comes from src/lib/bookshelf.ts (draft, in review, sent
// back, live, live with waiting changes / changes in review / changes
// sent back, taken down): a status line with a dot, one main button per
// state (a live book's is its book page), the series and position, and a
// "···" menu with only the items that apply (shelfMenuItems). Renato
// 11-05 Q3 a: no Delete on a live book. The page passes `state` (it
// needs it for the filter); without it the row derives it from the
// takedown and review notices, as before P6.
const MENU_ITEM_BASE = "focus-ring flex min-h-11 w-full items-center px-4 text-left text-sm font-medium hover:bg-surface-hover";
const MENU_ITEM_CLASSES = `${MENU_ITEM_BASE} text-foreground`;
// Red text on white, 6.6:1.
const MENU_DELETE_CLASSES = `${MENU_ITEM_BASE} text-[#b42318]`;

// The status dot, by state (decorative: the label carries the meaning).
const DOT_CLASSES: Record<ShelfState, string> = {
  draft: "bg-[#8c8472]",
  in_review: "bg-[#806510]",
  sent_back: "bg-[#b42318]",
  live: "bg-[#1e5c3e]",
  live_changes: "bg-[#1e5c3e]",
  live_in_review: "bg-[#806510]",
  live_sent_back: "bg-[#b42318]",
  preorder: "bg-[#2b5a8a]",
  preorder_changes: "bg-[#2b5a8a]",
  preorder_in_review: "bg-[#806510]",
  preorder_sent_back: "bg-[#b42318]",
  taken_down: "bg-[#8e2a1e]",
};

const MENU_LABELS: Record<Exclude<ShelfMenuItem, "delete">, string> = {
  view_page: "Shikojeni në Librari",
  preview_page: "Shikoni librin para botimit",
  edit_details: "Ndryshoni të dhënat",
  edit_content: "Ndryshoni dorëshkrimin ose ballinën",
  edit_price: "Ndryshoni çmimin",
  series: "Seria dhe vendi në seri",
  download_file: "Shkarkoni skedarin tuaj",
  discard_changes: "Hidhni poshtë ndryshimet",
  unpublish: "Hiqeni nga shitja",
  cancel_preorder: "Anuloni parapublikimin",
};

function menuHref(item: Exclude<ShelfMenuItem, "delete">, bookId: string): string {
  switch (item) {
    case "view_page":
    case "preview_page":
      return `/libra/${bookId}`;
    case "edit_details":
    case "series":
    // Audit P6 r1 N1: the discard button sits in the live-edit notice at
    // the top of the editor's Details tab, not in the Veprime box.
    case "discard_changes":
      return editorPath(bookId, "details");
    case "edit_content":
      return editorPath(bookId, "content");
    case "edit_price":
      return editorPath(bookId, "pricing");
    case "download_file":
      return `/api/books/${bookId}/download`;
    // In the editor's Veprime box, with its explanation and
    // confirmation (CLEANUP-1 reasoning above).
    case "unpublish":
    case "cancel_preorder":
      return `${editorPath(bookId, "details")}#${BOOK_ACTIONS_ID}`;
  }
}

export function AuthorBookRow({
  book,
  coverUrl,
  recentCopies = null,
  missing = [],
  takedown = null,
  review = null,
  state: givenState,
  seriesTitle = null,
  waitingReaders = null,
}: {
  book: Pick<Book, "id" | "title" | "status" | "price_all" | "genre" | "published_at"> &
    Partial<Pick<Book, "series_position" | "file_path" | "pd_work_id" | "release_date">>;
  coverUrl: string | null;
  recentCopies?: number | null;
  missing?: string[];
  takedown?: AuthorTakedownNotice | null;
  review?: AuthorReviewNotice | null;
  state?: ShelfState;
  /** The book's series, shown on the card (null: none, or shown as the group heading). */
  seriesTitle?: string | null;
  /** BD16 P2: readers waiting for a pre-order (null: not shown). */
  waitingReaders?: number | null;
}) {
  const state =
    givenState ??
    resolveShelfState(book, { takenDown: takedown !== null, review, hasPendingChanges: false, pendingSentBack: false });
  const copy = shelfStateCopy(state, book);
  const live = isLiveState(state);
  // BD16 P2: a pre-order's day, and (until its final file is approved)
  // the file's due date.
  const preorder = isPreorderState(state) && book.status === "preorder" && book.release_date ? book.release_date : null;
  const preorderLine = preorder
    ? [
        `Del më ${formatReleaseDay(preorder)}`,
        book.file_path ? null : `Dorëshkrimi final deri më ${formatReleaseDay(preorderFileDueDate(preorder))}`,
        waitingReaders !== null && waitingReaders > 0 ? waitingReadersLine(waitingReaders) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : null;
  const isDraft = book.status === "draft";
  const sentBack =
    state === "sent_back" || state === "live_sent_back" || state === "preorder_sent_back" ? (review?.sentBack ?? null) : null;
  const priceLabel = book.price_all === null ? "Pa çmim ende" : formatCatalogPriceLabel(book.price_all);
  const isFree = resolveCatalogPriceState(book.price_all) === "free";
  // BD15 P7: a public-domain edition Librum picked, or replaced (Q1/Q2 a).
  const pdLine = pdShelfLine(book, takedown !== null);
  const menu = shelfMenuItems({
    state,
    status: book.status,
    hasFile: Boolean(book.file_path),
    pdPicked: isPickedPdEdition(book),
  });

  // Upload notes 3a (Enkelejd 11-06): the file format, not "E-libër".
  const facts = [
    "EPUB",
    book.genre,
    !isDraft && book.published_at ? `Publikuar më ${formatTimestampAsDate(book.published_at)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  // BD16 P2: a pre-order has no sales or downloads yet.
  const showRecent = book.status === "published" && recentCopies !== null;
  const recentNoun = isFree
    ? recentCopies === 1
      ? "shkarkim"
      : "shkarkime"
    : "shitje";

  const mainHref =
    copy.action === "book_page"
      ? `/libra/${book.id}`
      : editorPath(book.id, copy.action === "content" ? "content" : "details");

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
        {(seriesTitle !== null || book.series_position) && (
          <p className="text-sm text-muted">
            {[seriesTitle, book.series_position ? `Libri ${book.series_position}` : null].filter(Boolean).join(" · ")}
          </p>
        )}
        <p className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${DOT_CLASSES[state]}`} />
          <span>{copy.label}</span>
        </p>
        {preorderLine && <p className="text-[0.8125rem] text-muted">{preorderLine}</p>}
        {copy.line && <p className="text-[0.8125rem] text-muted">{copy.line}</p>}
        {pdLine && <p className="text-[0.8125rem] text-muted">{pdLine}</p>}
        <p className="text-sm text-muted">{facts}</p>
        {/* Phone: price and the 30-day figure share one line, as on the
            phone mockup; from sm up they are their own columns. */}
        <p className="text-sm text-muted sm:hidden">
          {priceLabel}
          {showRecent && ` · ${recentCopies} ${recentNoun} (30 ditë)`}
        </p>
        {state === "draft" && missing.length > 0 && (
          <p className="text-[0.8125rem] text-muted">{`Për t'u bërë: ${missing.join(" · ")}`}</p>
        )}
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
            {buildAuthorSentBackNoticeLines(sentBack, formatTimestampAsDate, live || preorder !== null).map((line, index) => (
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
        {copy.primary ? (
          <Link
            href={mainHref}
            className="focus-ring inline-flex min-h-11 items-center justify-center rounded-[3px] bg-accent px-4 text-sm font-bold text-accent-foreground transition-colors hover:bg-[#c9a42c]"
          >
            {copy.button}
          </Link>
        ) : (
          <Link
            href={mainHref}
            className={buttonClasses("outline", "sm", "min-h-11 rounded-[3px] border-[#c9c0ae] px-4 font-semibold")}
          >
            {copy.button}
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
              off the screen however wide the main button is. From sm up
              they end the row and it opens leftwards under the ···. */}
          <div className="absolute left-0 top-full z-10 mt-1 w-64 sm:left-auto sm:right-0 rounded-[3px] border border-border bg-surface py-1 shadow-md">
            <ul>
              {menu.map((item) =>
                item === "delete" ? (
                  <li key={item} className="mt-1 border-t border-border pt-1">
                    <form action={deleteBook.bind(null, book.id)}>
                      <DeleteBookButton title={book.title} className={MENU_DELETE_CLASSES} />
                    </form>
                  </li>
                ) : item === "download_file" ? (
                  // A file download, not a page: a plain link.
                  <li key={item}>
                    <a href={menuHref(item, book.id)} className={MENU_ITEM_CLASSES}>
                      {MENU_LABELS[item]}
                    </a>
                  </li>
                ) : (
                  <li key={item}>
                    <Link
                      href={menuHref(item, book.id)}
                      className={
                        item === "discard_changes" || item === "unpublish" || item === "cancel_preorder"
                          ? MENU_DELETE_CLASSES : MENU_ITEM_CLASSES
                      }
                    >
                      {MENU_LABELS[item]}
                    </Link>
                  </li>
                ),
              )}
            </ul>
          </div>
        </DismissableDetails>
      </div>
    </li>
  );
}
