import Link from "next/link";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { DeleteBookButton } from "@/app/(public)/dashboard/delete-book-button";
import { descriptionPlainText } from "@/lib/book-description";
import { CANCEL_REVIEW_LABEL, IN_REVIEW_READ_ONLY_NOTE } from "@/lib/book-review-copy";
import {
  BOOK_ACTIONS_HEADING,
  BOOK_ACTIONS_ID,
  DELETE_NOTE,
  DRAFT_IN_REVIEW_NOTE,
  LIVE_IN_REVIEW_NOTE,
  LIVE_IN_REVIEW_PUBLISHING_NOTE,
  PREVIEW_LINK,
  PREVIEW_NOTE,
  SENT_HEADING,
  UNPUBLISH_BUTTON,
  UNPUBLISH_NOTE,
  UNPUBLISH_PENDING_NOTE,
} from "@/lib/book-editor-copy";
import { TAKEN_DOWN_DELETE_MESSAGE } from "@/lib/takedown-reasons";

// BD15 P5b-3a: the parts of the old edit page that now live in the
// editor (the old page only redirects here).
//
//   * BookInReviewView -- a book waiting for review (draft or live) is
//     read-only (P5a Q2/Q3 a, P5b-2 Q2 a): what was sent, and
//     "Anuloni shqyrtimin". The database refuses edits too (LB490).
//   * BookActionsBox -- "Veprime" under every tab (Renato 11-04, Q3 a):
//     take a live book off sale, delete a book. A taken-down book can't
//     be deleted (the database refuses it too), so its note shows instead.

export type SentVersion = {
  title: string;
  subtitle: string | null;
  coverUrl: string | null;
  manuscriptLabel: string | null;
  priceAll: number | null;
  description: string;
};

function priceText(priceAll: number | null): string {
  return priceAll === null ? "Pa çmim ende" : priceAll === 0 ? "Falas" : `${priceAll} lekë`;
}

export function BookInReviewView({
  sent,
  live,
  cancelAction,
}: {
  sent: SentVersion;
  live: boolean;
  cancelAction: () => void | Promise<void>;
}) {
  return (
    <section id="in-review" className="mt-4 rounded-card border border-border bg-surface p-4 shadow-sm">
      <h2 className="font-serif text-xl font-normal">{SENT_HEADING}</h2>
      <p className="mt-2 text-sm text-muted">{IN_REVIEW_READ_ONLY_NOTE}</p>
      {live && <p className="mt-2 text-sm text-muted">{LIVE_IN_REVIEW_NOTE}</p>}
      <div className="mt-4 flex gap-4">
        {sent.coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={sent.coverUrl} alt="" className="h-36 w-24 shrink-0 rounded-sm object-cover" />
        ) : null}
        <dl className="flex flex-col gap-2 text-sm">
          <div>
            <dt className="text-muted">Titulli</dt>
            <dd className="font-medium">{sent.title}</dd>
          </div>
          {sent.subtitle ? (
            <div>
              <dt className="text-muted">Nëntitulli</dt>
              <dd>{sent.subtitle}</dd>
            </div>
          ) : null}
          <div>
            <dt className="text-muted">Dorëshkrimi</dt>
            <dd>{sent.manuscriptLabel ?? "Mungon"}</dd>
          </div>
          <div>
            <dt className="text-muted">Çmimi</dt>
            <dd>{priceText(sent.priceAll)}</dd>
          </div>
        </dl>
      </div>
      {sent.description ? (
        <p className="mt-4 whitespace-pre-wrap break-words text-sm">{descriptionPlainText(sent.description)}</p>
      ) : null}
      <p className="mt-4 text-sm text-muted">{live ? LIVE_IN_REVIEW_PUBLISHING_NOTE : DRAFT_IN_REVIEW_NOTE}</p>
      <form action={cancelAction} className="mt-4">
        <button type="submit" className={buttonClasses("outline", "md", "w-full sm:w-auto")}>
          {CANCEL_REVIEW_LABEL}
        </button>
      </form>
    </section>
  );
}

export function BookActionsBox({
  bookId,
  title,
  live,
  hasPendingChanges,
  takenDown,
  unpublishAction,
  deleteAction,
}: {
  bookId: string;
  title: string;
  live: boolean;
  // A live book's changes waiting (saved or in review): taking it off
  // sale makes them part of the draft (P5b Q3 a).
  hasPendingChanges: boolean;
  takenDown: boolean;
  unpublishAction: () => void | Promise<void>;
  deleteAction: () => void | Promise<void>;
}) {
  return (
    <section
      id={BOOK_ACTIONS_ID}
      aria-labelledby={`${BOOK_ACTIONS_ID}-heading`}
      className="mt-8 scroll-mt-6 rounded-card border border-dashed border-border p-4"
    >
      <h2 id={`${BOOK_ACTIONS_ID}-heading`} className="font-serif text-lg font-normal">
        {BOOK_ACTIONS_HEADING}
      </h2>
      {!live && (
        // PREVIEW-1 (A5, Renato 6a), from the old edit page: the book's
        // own page as readers will see it, in a new tab so nothing typed
        // here is lost. It shows what was last saved.
        <p className="mt-3 text-sm text-muted">
          <Link
            href={`/libra/${bookId}`}
            target="_blank"
            rel="noopener"
            className="focus-ring rounded-sm font-medium text-foreground underline"
          >
            {PREVIEW_LINK}
            <span className="sr-only"> (hapet në një skedë të re)</span>
          </Link>
          . {PREVIEW_NOTE}
        </p>
      )}
      {live && (
        <div className="mt-3">
          <p className="text-sm text-muted">
            {UNPUBLISH_NOTE}
            {hasPendingChanges && ` ${UNPUBLISH_PENDING_NOTE}`}
          </p>
          <form action={unpublishAction} className="mt-2">
            <button type="submit" className={buttonClasses("outline", "md", "w-full sm:w-auto")}>
              {UNPUBLISH_BUTTON}
            </button>
          </form>
        </div>
      )}
      <div className="mt-4 border-t border-border pt-4">
        {takenDown ? (
          <Alert variant="warning">{TAKEN_DOWN_DELETE_MESSAGE}</Alert>
        ) : (
          <>
            <p className="text-sm text-muted">{DELETE_NOTE}</p>
            <form action={deleteAction} className="mt-2">
              <DeleteBookButton title={title} />
            </form>
          </>
        )}
      </div>
    </section>
  );
}
