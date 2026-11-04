import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { discardBookPendingChanges, saveBookDetails } from "../../editor-actions";
import { saveBookContent, saveBookPricing } from "../../actions";
import { createCatalogWriteClient } from "@/lib/catalog-write-client";
import { changedPendingFields, readPendingChanges, type PendingChanges } from "@/lib/book-pending-changes";
import { LiveEditNotice } from "@/components/live-edit-notice";
import { BookPricingForm, type PricingMissing } from "@/components/book-pricing-form";
import { isFreeOnlyRightsBasis } from "@/lib/book-pricing";
import { canPublishPaidTitle, canStartPaidCheckout } from "@/lib/paid-readiness";
import { getActiveTakedownState } from "@/lib/book-takedowns";
import { buildAuthorSentBackNoticeLines } from "@/lib/book-review-copy";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { BookContentForm } from "@/components/book-content-form";
import { readAiDisclosure } from "@/lib/book-ai-disclosure";
import { ebookCoverNotice } from "@/lib/ebook-cover-notice";
import { Alert } from "@/components/ui/alert";
import { BookEditorShell } from "@/components/book-editor-shell";
import { BookDetailsForm, type DetailsFormValues } from "@/components/book-details-form";
import { getRightsDeclarationState } from "@/lib/book-rights";
import { getBookReviewState } from "@/lib/book-reviews";
import { missingDetails } from "@/lib/book-details";
import { isEditorTab, type EditorTab } from "@/lib/book-editor-copy";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";

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
};

// BD15 P2: the new book editor for a draft (PLAN-BD15-r1 §2.2): Details
// (P2), Content (P3) and Pricing with "Send for review" (P4). A book in
// review and a taken-down book keep the existing edit page (a book in
// review shows there read-only, P5a); the edit page sends every other
// draft here (P4), so the editor's Pricing tab is the one way a draft is
// sent.
//
// BD15 P5b-2: a LIVE book not waiting for review is edited here too and
// stays live. Its manuscript, ballinë, description, 18+ label and
// original author are shown from its waiting changes when it has any
// (book_pending_changes) and are saved there; the Pricing tab sends
// them for review. Everything else saves straight onto the live book.
// Taking it off sale and deleting it stay on the edit page until P5b-3.
export default async function BookEditorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; error?: string; success?: string; ebook_cover?: string }>;
}) {
  const { id } = await params;
  const { tab: rawTab, error: rawError, success: rawSuccess, ebook_cover: rawEbookCover } = await searchParams;
  const tab: EditorTab = isEditorTab(rawTab) ? rawTab : "details";

  if (!UUID.test(id)) notFound();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    redirect(`/login?next=/dashboard/books/${id}/editor`);
  }

  const { data: book } = await supabase
    .from("books")
    .select(
      "id, author_id, title, subtitle, language, series_id, series_position, edition_number, pen_name_id, description, is_adult, reading_age_min, categories, keywords, original_author, status, published_at, file_path, cover_path, price_all, isbn, publisher",
    )
    .eq("id", id)
    .eq("author_id", user.id)
    .maybeSingle<EditorBook>();
  if (!book || book.author_id !== user.id) notFound();

  const live = book.status === "published";
  if (book.status !== "draft" && !live) redirect(`/dashboard/books/${book.id}/edit`);
  // BD15 P4: exactly the complement of the edit page's redirect here
  // (editorOwnsDraft), so the two pages never send a book back and forth.
  // P5b-2: a live book in review shows read-only on the edit page too.
  const [review, takedown] = await Promise.all([
    getBookReviewState(supabase, book.id),
    getActiveTakedownState(supabase, book.id),
  ]);
  if (review.kind !== "ok" || review.pending || takedown.kind !== "none") {
    redirect(`/dashboard/books/${book.id}/edit`);
  }

  // P5b-2: the live book's waiting changes, read by the trusted writer
  // now that the book is proven the caller's own. Unreadable: nothing
  // is shown that could be saved over them.
  let pending: PendingChanges | null = null;
  if (live) {
    const read = await readPendingChanges(createCatalogWriteClient(), book.id);
    if (!read.ok) redirect(`/dashboard?error=${encodeURIComponent("Diçka shkoi keq. Provoni përsëri")}`);
    pending = read.pending;
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
  const locked = book.published_at !== null;
  const penNameList = penNames ?? [];
  const lockedPenName = penNameList.find((p) => p.id === book.pen_name_id)?.name ?? null;

  const detailsMissing = missingDetails({
    title: book.title,
    categories: book.categories,
    description: working.description,
    rightsBasis,
    originalAuthor: working.originalAuthor,
  });
  // BD15 P3 (mockup): the manuscript, the cover and the AI answer.
  const contentMissing = [
    ...(working.filePath === null ? ["Dorëshkrimi"] : []),
    ...(working.coverPath === null ? ["Ballina"] : []),
    ...(!ai.ok || ai.answer === null ? ["Pyetja për AI"] : []),
  ];
  const done: Record<EditorTab, boolean> = {
    details: detailsMissing.length === 0,
    content: contentMissing.length === 0,
    pricing: book.price_all !== null,
  };
  // BD15 P4: what "Send for review" still needs from the other tabs.
  const sendMissing: PricingMissing[] = [
    ...detailsMissing.map((label) => ({ tab: "details" as const, label })),
    ...contentMissing.map((label) => ({ tab: "content" as const, label })),
  ];
  const sentBack = review.latestSentBack;

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
      statusLabel={live ? "Në shitje" : "Draft"}
      tab={tab}
      done={done}
      error={pageErrorMessage(rawError)}
      success={pageSuccessMessage(rawSuccess)}
    >
      {/* BD15 P4: a book Librum sent back is fixed here now, so the
          staff note shows on every tab until it is sent again. */}
      {live && (
        <LiveEditNotice
          bookId={book.id}
          changed={changed}
          discardAction={discardBookPendingChanges.bind(null, book.id)}
        />
      )}
      {sentBack && (
        <Alert variant="warning" className="mt-4">
          {buildAuthorSentBackNoticeLines(sentBack, formatTimestampAsDate).map((line, index) => (
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
              coverUrl: working.coverPath
                ? supabase.storage.from("covers").getPublicUrl(working.coverPath).data.publicUrl
                : null,
            }}
            live={live}
            authorId={user.id}
            authorName={penNameList.find((p) => p.id === book.pen_name_id)?.name ?? ""}
            aiAnswer={ai.ok ? ai.answer : null}
            aiUnreadable={!ai.ok}
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
          approvalValid={!live && review.approvalValid}
          live={live ? { currentPriceAll: book.price_all, hasChanges: changed.length > 0 } : null}
          title={book.title}
          penName={lockedPenName ?? ""}
          missing={sendMissing}
        />
      )}
    </BookEditorShell>
  );
}
