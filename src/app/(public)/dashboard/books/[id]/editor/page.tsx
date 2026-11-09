import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { discardBookPendingChanges, saveBookDetails } from "../../editor-actions";
import {
  cancelBookReview,
  cancelPreorder,
  deleteBook,
  pushPreorderDate,
  saveBookContent,
  saveBookPricing,
  unpublishBook,
} from "../../actions";
import { createCatalogWriteClient } from "@/lib/catalog-write-client";
import { changedPendingFields, readPendingChanges, type PendingChanges } from "@/lib/book-pending-changes";
import { LiveEditNotice } from "@/components/live-edit-notice";
import { BookPricingForm, type PricingMissing, type PricingRelease } from "@/components/book-pricing-form";
import { isFreeOnlyRightsBasis } from "@/lib/book-pricing";
import { canPublishPaidTitle, canStartPaidCheckout } from "@/lib/paid-readiness";
import { loadAuthorTakedownNoticeForBook } from "@/lib/book-takedowns";
import { buildAuthorTakedownNoticeLines } from "@/lib/takedown-reasons";
import { IN_REVIEW_LABEL, buildAuthorSentBackNoticeLines } from "@/lib/book-review-copy";
import { BookActionsBox, BookInReviewView, type SentVersion } from "@/components/book-editor-panels";
import { getManuscriptLabel } from "@/lib/manuscript-label";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { BookContentForm } from "@/components/book-content-form";
import { readAiDisclosure } from "@/lib/book-ai-disclosure";
import { ebookCoverNotice } from "@/lib/ebook-cover-notice";
import { Alert } from "@/components/ui/alert";
import { BookEditorShell } from "@/components/book-editor-shell";
import { BookDetailsForm, type DetailsFormValues } from "@/components/book-details-form";
import { getRightsDeclarationState } from "@/lib/book-rights";
import { getBookReviewState } from "@/lib/book-reviews";
import { PD_PICKED_EDITOR_NOTE, isPickedPdEdition } from "@/lib/pd-editions";
import { missingDetailItems } from "@/lib/book-details";
import { resolveBookByline } from "@/lib/book-byline";
import {
  CONTENT_MISSING_AI,
  CONTENT_MISSING_COVER,
  CONTENT_MISSING_MANUSCRIPT,
  LIVE_STATUS_LABEL,
  TAKEN_DOWN_SEND_NOTE,
  TAKEN_DOWN_STATUS_LABEL,
  isEditorTab,
  type EditorTab,
} from "@/lib/book-editor-copy";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import { getPreorderSchemaFeature } from "@/lib/catalog-schema-features";
import { PreorderPanel } from "@/components/preorder-panel";
import {
  PREORDER_BLOCK_NOTES,
  countWaitingReaders,
  preorderBlock,
  preorderDateWindow,
  preorderFinalFileState,
  preorderPushState,
  preorderStatusLabel,
  tiranaToday,
} from "@/lib/preorders";

export const metadata: Metadata = {
  title: "Redaktori i librit",
};

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type EditorBook = {
  id: string;
  author_id: string;
  title: string;
  subtitle: string | null;
  language: string | null;
  series_id: string | null;
  series_position: number | null;
  edition_number: number | null;
  pen_name_id: string;
  description: string;
  is_adult: boolean;
  reading_age_min: number | null;
  book_type: string | null;
  categories: string[] | null;
  keywords: string;
  original_author: string | null;
  status: string;
  published_at: string | null;
  file_path: string | null;
  cover_path: string | null;
  price_all: number | null;
  isbn: string | null;
  publisher: string | null;
  // BD15 P7: set by staff when it is a public-domain work's edition.
  pd_work_id: string | null;
  // BD16 P2: read only once the pre-order columns exist (P1 migration).
  release_date?: string | null;
  preorder_count?: number;
  preorder_slip_used?: boolean;
  preorder_listed_at?: string | null;
};

// BD15 P2: the new book editor for a draft (PLAN-BD15-r1 §2.2): Details
// (P2), Content (P3) and Pricing with "Send for review" (P4); the
// Pricing tab is the one way a draft is sent.
//
// BD15 P5b-2: a LIVE book not waiting for review is edited here too and
// stays live. Its manuscript, ballinë, description, 18+ label and
// original author are shown from its waiting changes when it has any
// (book_pending_changes) and are saved there; the Pricing tab sends
// them for review. Everything else saves straight onto the live book.
//
// BD15 P5b-3a: the old edit page is gone (it redirects here), so every
// book opens here:
//   * waiting for review (draft or live): read-only -- what was sent and
//     "Anuloni shqyrtimin" (P5a Q2/Q3 a, P5b-2 Q2 a);
//   * taken down by Librum: edited like a draft, with Librum's notice;
//     it is never sent (Renato 11-04, Q2 a; LB460 refuses it too);
//   * every tab ends with the "Veprime" box -- take a live book off
//     sale, delete a book (Q3 a).
export default async function BookEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; error?: string; success?: string; ebook_cover?: string; mungon?: string }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive page (renders books.price_all for
  // editing), checked first, before any Supabase call -- as the old edit
  // page did.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { id } = await params;
  const {
    tab: rawTab,
    error: rawError,
    success: rawSuccess,
    ebook_cover: rawEbookCover,
    mungon: rawShowMissing,
  } = await searchParams;
  // Upload notes 2 (Enkelejd 11-06): opened from the Pricing tab's to-do
  // list; the tab marks what is still missing for the send in red.
  const showMissing = rawShowMissing === "1";
  const tab: EditorTab = isEditorTab(rawTab) ? rawTab : "details";

  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=/dashboard/books/${id}/editor`);
  }

  // BD16 P2: the pre-order columns only where the database has them.
  const preorderFeature = await getPreorderSchemaFeature();
  const { data: book } = await supabase
    .from("books")
    .select(
      "id, author_id, title, subtitle, language, series_id, series_position, edition_number, pen_name_id, description, is_adult, reading_age_min, book_type, categories, keywords, original_author, status, published_at, file_path, cover_path, price_all, isbn, publisher, pd_work_id" +
        (preorderFeature ? ", release_date, preorder_count, preorder_slip_used, preorder_listed_at" : ""),
    )
    .eq("id", id)
    .eq("author_id", user.id)
    .maybeSingle<EditorBook>();
  if (!book || book.author_id !== user.id) notFound();

  // BD16 P2: a live pre-order ('preorder') is edited like a live book:
  // its manuscript, ballinë, description, 18+ label and original author
  // wait for review (book_pending_changes); the final file comes so too.
  if (book.status !== "draft" && book.status !== "published" && book.status !== "preorder") notFound();
  const preorder = book.status === "preorder" && typeof book.release_date === "string" ? book.release_date : null;
  if (book.status === "preorder" && preorder === null) notFound();
  const live = book.status === "published" || preorder !== null;
  // P5b-3a: an unreadable review or takedown state shows nothing that
  // could be saved or sent (the old edit page showed it with Publish
  // disabled; the actions refuse on their own too).
  const [review, takedownRead] = await Promise.all([
    getBookReviewState(supabase, book.id),
    loadAuthorTakedownNoticeForBook(supabase, book.id),
  ]);
  if (review.kind !== "ok" || takedownRead.state.kind === "unavailable") {
    redirect(`/dashboard?error=${encodeURIComponent("Diçka shkoi keq. Provoni përsëri")}`);
  }
  const takedownNotice = takedownRead.notice;
  const takenDown = takedownRead.state.kind === "active";
  // As the old edit page: a takedown outranks a pending review.
  const inReview = !takenDown && review.pending;

  // P5b-2: the live book's waiting changes, read by the trusted writer
  // now that the book is proven the caller's own. Unreadable: nothing
  // is shown that could be saved over them.
  let pending: PendingChanges | null = null;
  let pendingCreatedAt: string | null = null;
  if (live) {
    const read = await readPendingChanges(createCatalogWriteClient(), book.id);
    if (read.ok) {
      pending = read.pending;
      pendingCreatedAt = read.createdAt;
    } else if (!inReview) {
      redirect(`/dashboard?error=${encodeURIComponent("Diçka shkoi keq. Provoni përsëri")}`);
    }
    // In review nothing can be saved, so an unreadable read shows the
    // live values read-only (as the old edit page did).
  }
  const liveValues: PendingChanges = {
    filePath: book.file_path,
    coverPath: book.cover_path,
    description: book.description,
    isAdult: book.is_adult,
    originalAuthor: book.original_author,
  };
  // What the editor shows and checks: the waiting version when there is one.
  const working: PendingChanges = pending ?? liveValues;
  const changed = pending ? changedPendingFields(liveValues, pending) : [];
  const coverUrl = working.coverPath
    ? supabase.storage.from("covers").getPublicUrl(working.coverPath).data.publicUrl
    : null;
  // BD16 P2: readers waiting for this pre-order (a count; display only).
  const waiting = preorder ? ((await countWaitingReaders(createCatalogWriteClient(), [book.id]))?.get(book.id) ?? 0) : null;
  const preorderPanel = preorder ? (
    <PreorderPanel
      releaseDate={preorder}
      finalFile={preorderFinalFileState({
        bookFilePath: book.file_path,
        pendingFilePath: pending?.filePath ?? null,
        inReview: inReview && (pending?.filePath ?? null) !== null,
      })}
      waitingReaders={waiting}
      push={preorderPushState(
        { release_date: preorder, preorder_slip_used: book.preorder_slip_used === true },
        tiranaToday(),
      )}
      pushAction={pushPreorderDate.bind(null, book.id)}
    />
  ) : null;
  const actionsBox = (
    <BookActionsBox
      preorder={
        preorder
          ? {
              cancelAction: cancelPreorder.bind(null, book.id),
              waiting,
              preorderCount: book.preorder_count ?? 1,
            }
          : null
      }
      title={book.title}
      live={live}
      hasPendingChanges={changed.length > 0}
      takenDown={takenDown}
      bookId={book.id}
      unpublishAction={unpublishBook.bind(null, book.id)}
      deleteAction={deleteBook.bind(null, book.id)}
      pdPicked={isPickedPdEdition(book)}
    />
  );

  if (inReview) {
    // What was sent: a live book's waiting version, else the book itself.
    const sent: SentVersion = {
      title: book.title,
      subtitle: book.subtitle,
      coverUrl,
      manuscriptLabel: getManuscriptLabel(working.filePath),
      priceAll: book.price_all,
      description: working.description ?? "",
      // A listing asks for its release day (a draft's release_date).
      releaseDate: !live ? (book.release_date ?? null) : null,
    };
    return (
      <BookEditorShell
        bookId={book.id}
        heading={book.title}
        statusLabel={preorder ? `${preorderStatusLabel(preorder)} · ${IN_REVIEW_LABEL}` : IN_REVIEW_LABEL}
        tab={tab}
        done={{ details: true, content: true, pricing: true }}
        error={pageErrorMessage(rawError)}
        success={pageSuccessMessage(rawSuccess)}
        readOnly
      >
        {preorderPanel}
        <BookInReviewView
          sent={sent}
          live={live}
          preorder={preorder !== null}
          cancelAction={cancelBookReview.bind(null, book.id)}
        />
        {actionsBox}
      </BookEditorShell>
    );
  }

  const [{ data: penNames }, { data: series }, { data: contributors }, rights, ai] = await Promise.all([
    supabase
      .from("pen_names")
      .select("id, name, is_default")
      .eq("author_id", user.id)
      .order("created_at")
      .returns<{ id: string; name: string; is_default: boolean }[]>(),
    supabase
      .from("series")
      .select("id, title, pen_name_id")
      .eq("author_id", user.id)
      .order("title")
      .returns<{ id: string; title: string; pen_name_id: string | null }[]>(),
    supabase
      .from("book_contributors")
      .select("id, name, role")
      .eq("book_id", book.id)
      .order("created_at")
      .returns<{ id: string; name: string; role: string }[]>(),
    getRightsDeclarationState(book.id),
    // BD15 P3: the staff-only AI answer, read by the trusted writer only
    // now that the book is proven the caller's own draft.
    readAiDisclosure(book.id),
  ]);

  // P5b-2 (audit r1 F1): an older live book with no rights record keeps
  // own rights -- the only basis the database allows it (LB492) -- so the
  // locked choice shows and sends exactly that.
  const rightsBasis =
    rights.kind === "present" ? rights.declaration.basis : live && rights.kind === "none" ? "own_rights" : null;
  // BD16 P2 (D4): a book ever listed as a pre-order keeps its title and
  // pen name, also after a cancel (books_lock_after_first_publish).
  const locked = book.published_at !== null || (book.preorder_listed_at ?? null) !== null;
  const penNameList = penNames ?? [];
  const lockedPenName = penNameList.find((p) => p.id === book.pen_name_id)?.name ?? null;

  const detailsMissingItems = missingDetailItems({
    title: book.title,
    bookType: book.book_type,
    categories: book.categories,
    description: working.description,
    rightsBasis,
    originalAuthor: working.originalAuthor,
  });
  const detailsMissing = detailsMissingItems.map((m) => m.label);
  // BD15 P3 (mockup): the manuscript, the cover and the AI answer.
  // BD16 P2: a pre-order's final manuscript is followed in its own box
  // (PreorderPanel), not as a missing item.
  const contentMissing = [
    ...(working.filePath === null && preorder === null ? [CONTENT_MISSING_MANUSCRIPT] : []),
    ...(working.coverPath === null ? [CONTENT_MISSING_COVER] : []),
    ...(!ai.ok || ai.answer === null ? [CONTENT_MISSING_AI] : []),
  ];
  const done: Record<EditorTab, boolean> = {
    details: detailsMissing.length === 0,
    content: contentMissing.length === 0,
    pricing: book.price_all !== null,
  };
  // BD15 P4: what "Send for review" still needs from the other tabs.
  // BD16 P2: a pre-order listing may be sent without the manuscript (D5).
  const sendMissing: PricingMissing[] = [
    ...detailsMissing.map((label) => ({ tab: "details" as const, label })),
    ...contentMissing.map((label) => ({ tab: "content" as const, label, preorderOptional: label === CONTENT_MISSING_MANUSCRIPT })),
  ];
  // BD16 P2: a draft's "Kur del libri" choice, once the database has
  // pre-orders. A taken-down book is never sent, so it gets none.
  const block =
    !live && !takenDown && preorderFeature
      ? preorderBlock({
          published_at: book.published_at,
          preorder_count: book.preorder_count ?? 0,
          pd_work_id: book.pd_work_id,
          rightsBasis,
        })
      : null;
  const release: PricingRelease | null =
    live || takenDown || !preorderFeature
      ? null
      : block !== null
        ? { available: false, note: PREORDER_BLOCK_NOTES[block] }
        : {
            available: true,
            initialMode: book.release_date ? "preorder" : "now",
            initialDate: book.release_date ?? "",
            window: preorderDateWindow(tiranaToday()),
          };
  // P5b-3a: a live book's sent-back note is about the changes it was
  // sent with. Once they are discarded (or replaced by changes first
  // saved after it), the note is stale and no longer shows. A draft's
  // note shows until it is sent again (P4).
  const latestSentBack = takenDown ? null : review.latestSentBack;
  const sentBack =
    latestSentBack &&
    (!live ||
      (pending !== null &&
        pendingCreatedAt !== null &&
        Date.parse(pendingCreatedAt) <= Date.parse(latestSentBack.sentBackAt)))
      ? latestSentBack
      : null;

  const initial: DetailsFormValues = {
    title: book.title,
    subtitle: book.subtitle ?? "",
    language: book.language ?? "sq",
    seriesId: book.series_id ?? "",
    seriesPosition: book.series_position !== null ? String(book.series_position) : "",
    editionNumber: book.edition_number !== null ? String(book.edition_number) : "",
    penNameId: book.pen_name_id,
    description: working.description ?? "",
    isAdult: working.isAdult,
    readingAge: book.reading_age_min !== null ? String(book.reading_age_min) : "",
    bookType: book.book_type ?? "",
    categories: book.categories ?? [],
    keywords: book.keywords ?? "",
    contributors: (contributors ?? []).map((c) => ({ id: c.id, name: c.name, role: c.role })),
    rightsBasis: rightsBasis ?? "",
    originalAuthor: working.originalAuthor ?? "",
  };

  return (
    <BookEditorShell
      bookId={book.id}
      heading={book.title}
      statusLabel={
        preorder ? preorderStatusLabel(preorder) : live ? LIVE_STATUS_LABEL : takenDown ? TAKEN_DOWN_STATUS_LABEL : "Draft"
      }
      tab={tab}
      done={done}
      error={pageErrorMessage(rawError)}
      success={pageSuccessMessage(rawSuccess)}
    >
      {/* BD15 P4: a book Librum sent back is fixed here now, so the
          staff note shows on every tab until it is sent again. */}
      {preorderPanel}
      {live && (
        <LiveEditNotice
          preorder={preorder !== null}
          bookId={book.id}
          changed={changed}
          discardAction={discardBookPendingChanges.bind(null, book.id)}
        />
      )}
      {/* BD15 P7 (Q1 a): what still changes on a picked edition. */}
      {isPickedPdEdition(book) && (
        <Alert variant="warning" className="mt-4">
          {PD_PICKED_EDITOR_NOTE}
        </Alert>
      )}
      {takedownNotice && (
        <Alert variant="error" className="mt-4">
          {buildAuthorTakedownNoticeLines(takedownNotice, formatTimestampAsDate).map((line, index) => (
            <p key={index} className={index === 0 ? "font-semibold" : "mt-1 whitespace-pre-wrap break-words"}>
              {line}
            </p>
          ))}
        </Alert>
      )}
      {sentBack && (
        <Alert variant="warning" className="mt-4">
          {buildAuthorSentBackNoticeLines(sentBack, formatTimestampAsDate, live).map((line, index) => (
            <p key={index} className={index === 0 ? "font-semibold" : "mt-1 whitespace-pre-wrap break-words"}>
              {line}
            </p>
          ))}
        </Alert>
      )}
      {tab === "details" ? (
        <BookDetailsForm
          action={saveBookDetails.bind(null, book.id)}
          initial={initial}
          locked={locked}
          rightsLocked={live}
          live={live}
          lockedPenName={lockedPenName}
          penNames={penNameList}
          series={series ?? []}
          pdFrozen={isPickedPdEdition(book)}
          markMissing={showMissing ? detailsMissingItems.map((m) => m.field) : []}
        />
      ) : tab === "content" ? (
        <>
          {ebookCoverNotice(rawEbookCover) && (
            <Alert variant="warning" className="mt-4">
              {ebookCoverNotice(rawEbookCover)}
            </Alert>
          )}
          <BookContentForm
            action={saveBookContent.bind(null, book.id)}
            book={{
              id: book.id,
              title: book.title,
              language: book.language,
              isbn: book.isbn,
              publisher: book.publisher,
              hasManuscript: working.filePath !== null,
              coverUrl,
            }}
            live={live}
            authorId={user.id}
            authorName={penNameList.find((p) => p.id === book.pen_name_id)?.name ?? ""}
            aiAnswer={ai.ok ? ai.answer : null}
            aiUnreadable={!ai.ok}
            markMissing={showMissing ? contentMissing : []}
          />
        </>
      ) : (
        <BookPricingForm
          action={saveBookPricing.bind(null, book.id)}
          bookId={book.id}
          initialPriceAll={book.price_all}
          freeOnly={isFreeOnlyRightsBasis(rightsBasis)}
          paidPublishingAvailable={canPublishPaidTitle()}
          checkoutAvailable={canStartPaidCheckout()}
          approvalValid={!live && !takenDown && review.approvalValid}
          live={
            live
              ? { currentPriceAll: book.price_all, hasChanges: changed.length > 0, confirmPrice: preorder === null }
              : null
          }
          release={release}
          title={book.title}
          // BD15 follow-up (walkthrough F3): the name readers see -- the
          // original author of a public-domain or translated book, else
          // the pen name (resolveBookByline, as on the book page).
          byline={
            resolveBookByline({
              pen: lockedPenName ? { id: book.pen_name_id, name: lockedPenName } : null,
              original_author: working.originalAuthor,
            }) ?? ""
          }
          missing={sendMissing}
          sendRefusedNote={takenDown ? TAKEN_DOWN_SEND_NOTE : null}
        />
      )}
      {actionsBox}
    </BookEditorShell>
  );
}
