import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractEpubSample } from "@/lib/epub-sample";
import { readDownloadFilePath } from "@/lib/book-reviews";
import { resolveBookByline } from "@/lib/book-byline";
import {
  BOOK_MANUSCRIPTS_BUCKET,
  isOwnBookManuscriptPath,
} from "@/lib/book-storage-path";
import type { Book, PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";

// LIBRUM 2.0 AUTHOR-1B: the JSON response's own "author" field resolves
// through resolvePublicAuthorName(). Only the resolved string ever
// leaves this route; the profile object itself never rides along in the
// response.
//
// PEN-NAMES-1: the "author" field is the book's pen name, embedded from
// the public_pen_names view as `pen` (no account columns).
//
// MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: the row also returns its own `id`
// and `author_id`, so the stored manuscript key is checked against the
// row's own identity before the service-role client ever sees it.
//
// PEN-NAMES-2 (D2): the status, title and pen name come from public_books
// (no account columns). Only for a PUBLISHED book does a service-role
// read fetch author_id and file_path, and neither ever leaves this route.
//
// PREVIEW-1 (A5, Renato 3a/4a): the book's own author may read the sample
// of their own book in any state (draft, in review, sent back, taken
// down, live), from their CURRENT file -- that is the preview. Everyone
// else still needs a published book, and now reads the file of its latest
// APPROVED review (readDownloadFilePath, the same rule as the buyer's
// download). A new file already takes a live book out of the Bookstore
// (updateBook sets it back to draft), so this is defence in depth.
type SampleBookRow = Pick<PublicBook, "id" | "title" | "status"> & {
  pen: PenNameRef | null;
};
type SampleStorageRow = Pick<Book, "author_id"> & { file_path: unknown };

// Anything but one plain row object for exactly the requested id, with
// string title/status, is treated as no row at all.
function isSampleBookRow(data: unknown, requestedId: string): data is SampleBookRow {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const row = data as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id === requestedId &&
    typeof row.title === "string" &&
    typeof row.status === "string"
  );
}

// The service-role row: one plain object with a string author_id. Its
// file_path is checked below exactly as before: absent/empty is "no
// manuscript on file", anything else must be the canonical key.
function isSampleStorageRow(data: unknown): data is SampleStorageRow {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const row = data as Record<string, unknown>;
  return typeof row.author_id === "string";
}

// LIBRUM 2.0 PRODUCT-1: "Read sample" -- a genuine excerpt of the
// book's own EPUB manuscript, publicly readable without login for any
// published book. Deliberately separate from the owned-book download
// route (src/app/api/books/[id]/download/route.ts): that route is the
// SOLE full-manuscript delivery mechanism and stays untouched; this one
// can only ever return a small, sanitized, non-reconstructible excerpt
// (see extractEpubSample's own docs) -- never the manuscript's storage
// path, a signed URL to it, or its raw bytes.
//
// No recovery-session guard here (contrast the download route, which
// has one): that guard exists to contain a password-recovery-restricted
// session from doing ordinary AUTHENTICATED things. This route performs
// no auth-gated action at all -- an anonymous visitor, an ordinary
// reader, and a recovery-restricted session all get literally the same
// public response for the same published book, so there is no privilege
// boundary here for that containment to apply to.
//
// PREVIEW-1: the one exception is an author previewing their own
// unpublished book. Proxy already keeps a recovery-restricted session out
// of every /api/* route (LAUNCH-1 P1-11), and the preview only ever shows
// the caller their own book, so no guard is added here either.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: bookData, error: bookError } = await supabase
    .from("public_books")
    .select("id, title, status, original_author, pen:public_pen_names(id, name)")
    .eq("id", id)
    .maybeSingle<SampleBookRow>();

  // MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: a query error fails closed -- even
  // with plausible row data alongside it -- and looks exactly like a
  // missing book, as does any malformed or non-row result.
  const book = !bookError && isSampleBookRow(bookData, id) ? bookData : null;

  // LIBRUM 2.0 PRODUCT-1: belt-and-suspenders on top of RLS, same
  // philosophy as Book Detail's own visibility gate -- RLS ("Published
  // books are viewable by everyone, drafts by their author") already
  // means an anonymous request only ever gets a row back for a
  // published book, but this explicit check is what actually decides
  // visibility from this route's own point of view, and keeps that
  // legible without having to reason about the RLS policy to know what
  // it does. A draft, or a book that doesn't exist at all, gets the
  // identical safe 404 -- never distinguishing the two to an anonymous
  // caller.
  if (!book) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // PREVIEW-1: who is asking. Only an unpublished book needs a session;
  // for a published one it only decides which file (the author's current
  // file vs. the approved one). An auth error reads as anonymous.
  const isPublished = book.status === "published";
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const userId = !authError && authData?.user ? authData.user.id : null;
  if (!isPublished && !userId) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // PEN-NAMES-2: the service role reads the manuscript key and its owner
  // -- for a published book, or (PREVIEW-1) for an unpublished one, after
  // which only its own author passes. A read error or odd shape is the
  // same 404.
  const admin = createAdminClient();
  const storageQuery = admin.from("books").select("author_id, file_path").eq("id", book.id);
  const { data: storageData, error: storageError } = await (isPublished
    ? storageQuery.eq("status", "published")
    : storageQuery
  ).maybeSingle<SampleStorageRow>();
  const storageRow = !storageError && isSampleStorageRow(storageData) ? storageData : null;
  const isAuthor = !!storageRow && userId !== null && storageRow.author_id === userId;
  if (!storageRow || (!isPublished && !isAuthor)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // Absent/empty is "no manuscript on file", exactly as before; any other
  // value goes on to the path check below untouched.
  if (!storageRow.file_path) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // PREVIEW-1 (4a): which file. The author gets the current one; a reader
  // the latest approved one (or the current one if the book was never
  // approved). A review read error fails closed and never falls back to
  // the current file.
  const chosen = await readDownloadFilePath(admin, {
    bookId: book.id,
    isAuthor,
    currentFilePath: storageRow.file_path as string,
  });
  if (!chosen.ok) {
    return NextResponse.json({ error: "sample_unavailable" }, { status: 404 });
  }
  if (!chosen.filePath) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: this response is public, and the
  // service-role client bypasses Storage RLS (storage-js also puts the key
  // into the request URL unencoded, so "../" would leave the bucket). Only
  // the exact key `<row author_id>/<row id>.epub` (or, ADMIN-3, the
  // versioned `<row author_id>/<row id>/<uuid>.epub`) may be fetched; a
  // legacy or forged value gets the same controlled answer as an
  // unreadable manuscript, before any admin client, Storage request or
  // EPUB extraction, and without echoing the value.
  const filePath = chosen.filePath;
  if (!isOwnBookManuscriptPath(filePath, storageRow.author_id, book.id)) {
    return NextResponse.json({ error: "sample_unavailable" }, { status: 404 });
  }

  const { data: fileBlob, error: downloadError } = await admin.storage
    .from(BOOK_MANUSCRIPTS_BUCKET)
    .download(filePath);

  if (downloadError || !fileBlob) {
    // Never leak the underlying Supabase/storage error -- a missing or
    // unreadable manuscript looks the same to the caller as "no sample
    // for this book."
    return NextResponse.json({ error: "sample_unavailable" }, { status: 404 });
  }

  const bytes = Buffer.from(await fileBlob.arrayBuffer());
  const sample = await extractEpubSample(bytes);

  if (!sample.available) {
    return NextResponse.json({ error: "sample_unavailable" }, { status: 404 });
  }

  // F4 (P5): the sample's author line is the book's byline (pen name).
  // PREVIEW-1: the author's preview (their unapproved file, maybe a
  // draft) is never stored by any shared cache.
  return NextResponse.json(
    {
      bookId: id,
      title: book.title,
      author: resolveBookByline(book),
      sections: sample.sections,
      approximatePercent: sample.approximatePercent,
    },
    isAuthor ? { headers: { "Cache-Control": "private, no-store" } } : undefined,
  );
}
