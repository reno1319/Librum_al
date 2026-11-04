import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { saveBookDetails } from "../../editor-actions";
import { saveBookContent } from "../../actions";
import { BookContentForm } from "@/components/book-content-form";
import { readAiDisclosure } from "@/lib/book-ai-disclosure";
import { ebookCoverNotice } from "@/lib/ebook-cover-notice";
import { Alert } from "@/components/ui/alert";
import { BookEditorShell } from "@/components/book-editor-shell";
import { BookDetailsForm, type DetailsFormValues } from "@/components/book-details-form";
import { getRightsDeclarationState } from "@/lib/book-rights";
import { getBookReviewState } from "@/lib/book-reviews";
import { missingDetails } from "@/lib/book-details";
import {
  OPEN_EDIT_PAGE_LABEL,
  PRICING_TAB_INTERIM_NOTE,
  isEditorTab,
  type EditorTab,
} from "@/lib/book-editor-copy";
import { buttonClasses } from "@/components/ui/button";
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

// BD15 P2: the new book editor for a draft (PLAN-BD15-r1 §2.2). Details
// (P2) and Content (P3) are built here; Pricing points to the existing
// edit page until P4. A live book or a book in review keeps the existing
// edit page until P5.
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

  if (book.status !== "draft") redirect(`/dashboard/books/${book.id}/edit`);
  const review = await getBookReviewState(supabase, book.id);
  if (review.kind !== "ok" || review.pending) redirect(`/dashboard/books/${book.id}/edit`);

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

  const rightsBasis = rights.kind === "present" ? rights.declaration.basis : null;
  const locked = book.published_at !== null;
  const penNameList = penNames ?? [];
  const lockedPenName = penNameList.find((p) => p.id === book.pen_name_id)?.name ?? null;

  const done: Record<EditorTab, boolean> = {
    details:
      missingDetails({
        title: book.title,
        categories: book.categories,
        description: book.description,
        rightsBasis,
        originalAuthor: book.original_author,
      }).length === 0,
    // BD15 P3 (mockup): the manuscript, the cover and the AI answer.
    content: book.file_path !== null && book.cover_path !== null && ai.ok && ai.answer !== null,
    pricing: book.price_all !== null,
  };

  const initial: DetailsFormValues = {
    title: book.title,
    subtitle: book.subtitle ?? "",
    language: book.language ?? "sq",
    seriesId: book.series_id ?? "",
    seriesPosition: book.series_position !== null ? String(book.series_position) : "",
    editionNumber: book.edition_number !== null ? String(book.edition_number) : "",
    penNameId: book.pen_name_id,
    description: book.description ?? "",
    isAdult: book.is_adult,
    readingAge: book.reading_age_min !== null ? String(book.reading_age_min) : "",
    categories: book.categories ?? [],
    keywords: book.keywords ?? "",
    contributors: (contributors ?? []).map((c) => ({ id: c.id, name: c.name, role: c.role })),
    rightsBasis: rightsBasis ?? "",
    originalAuthor: book.original_author ?? "",
  };

  return (
    <BookEditorShell
      bookId={book.id}
      heading={book.title}
      statusLine="Libër elektronik · Draft"
      tab={tab}
      done={done}
      error={pageErrorMessage(rawError)}
      success={pageSuccessMessage(rawSuccess)}
    >
      {tab === "details" ? (
        <BookDetailsForm
          action={saveBookDetails.bind(null, book.id)}
          initial={initial}
          locked={locked}
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
              hasManuscript: book.file_path !== null,
              coverUrl: book.cover_path
                ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
                : null,
            }}
            authorId={user.id}
            authorName={penNameList.find((p) => p.id === book.pen_name_id)?.name ?? ""}
            aiAnswer={ai.ok ? ai.answer : null}
            aiUnreadable={!ai.ok}
          />
        </>
      ) : (
        <div className="mt-8 flex flex-col items-start gap-4 rounded-[4px] border border-border bg-surface p-6">
          <p>{PRICING_TAB_INTERIM_NOTE}</p>
          <Link href={`/dashboard/books/${book.id}/edit`} className={buttonClasses("primary", "md", "rounded-full")}>
            {OPEN_EDIT_PAGE_LABEL}
          </Link>
        </div>
      )}
    </BookEditorShell>
  );
}
