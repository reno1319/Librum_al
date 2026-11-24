import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isRecoverySessionActive } from "@/lib/recovery-session";
import { BOOK_MANUSCRIPTS_BUCKET, isOwnBookManuscriptPath } from "@/lib/book-storage-path";
import { readDownloadFilePath } from "@/lib/book-reviews";
import { buildReaderContent } from "@/lib/epub-reader";
import { resolveBookByline } from "@/lib/book-byline";
import { readLibrumPages } from "@/lib/librum-download-pages";
import { parseMyDownloadStates } from "@/lib/book-downloads";
import { MAX_READ_RESPONSE_BYTES, readConfirmed } from "@/lib/owned-reader";
import { readRightsBasisForPages } from "@/lib/librum-download-rights";
import { readerFrontPageHtml, readerLastPageHtml } from "@/lib/reader-librum-pages";
import { resolveSiteOrigin } from "@/lib/site-url";
import type { PenNameRef } from "@/lib/pen-names";

// Buyer reader (Renato 11-15, b): the whole book, for its buyer, in the
// page-turning reader ("Lexo" in Biblioteka ime and on the book page).
// This is a second full-text delivery path next to the download route
// (src/app/api/books/[id]/download/route.ts), so it keeps the download
// route's gates, in the same order:
//   - no recovery-restricted session; a signed-in user;
//   - the book is visible to the caller (public_books);
//   - the caller is its author or owns it (user_owns_book: refunds and
//     lost disputes do not own);
//   - the same file the download would give (readDownloadFilePath), only
//     at the book's own manuscript key.
// The text then goes through the same strict reader cleaner as the
// sample (buildReaderContent), so no book markup, link or URL reaches the
// browser, and the reader shows it in its script-less sandboxed frame.
//
// 1a: a buyer's first open ends the 14-day cancel right like a download:
// while the window is open the caller must send ?accept=1 (the reader's
// "Hapeni librin" step), else 409 confirm_needed. A failed state read
// asks for the confirmation too (never skips it). The open is written
// with record_book_download BEFORE any text is sent; if the record
// fails nothing is sent. The author's own open is not recorded.
// lbnp2 (Renato 11-24): the online book is the downloaded book: Librum's
// copyright page (buyer line included) after the cover, its last page at
// the end, read exactly as the download reads them.
// Never stored by a shared cache.

type ReadBookRow = { id: string; title: string; pen: PenNameRef | null; original_author: unknown };
type ReadStorageRow = { id: string; author_id: string; file_path: unknown };

const NO_STORE = { "Cache-Control": "private, no-store" };

function fail(status: number, error: string) {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

function isReadBookRow(data: unknown, requestedId: string): data is ReadBookRow {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const row = data as Record<string, unknown>;
  return row.id === requestedId && typeof row.title === "string";
}

function isReadStorageRow(data: unknown, requestedId: string): data is ReadStorageRow {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const row = data as Record<string, unknown>;
  return row.id === requestedId && typeof row.author_id === "string";
}

export function HEAD() {
  return new NextResponse(null, { status: 405, headers: { Allow: "GET" } });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const cookieStore = await cookies();
  if (isRecoverySessionActive(cookieStore)) return fail(403, "recovery_session");

  const supabase = await createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  const user = !authError ? authData?.user ?? null : null;
  if (!user) return fail(401, "sign_in");

  const { data: bookData, error: bookError } = await supabase
    .from("public_books")
    .select("id, title, original_author, pen:public_pen_names(id, name)")
    .eq("id", id)
    .maybeSingle();
  const book = !bookError && isReadBookRow(bookData, id) ? bookData : null;
  if (!book) return fail(404, "not_found");

  // Same ownership rule as the download route: the author, or a buyer
  // who currently owns the book.
  const { data: ownRow, error: ownRowError } = await supabase
    .from("books")
    .select("id")
    .eq("id", id)
    .eq("author_id", user.id)
    .maybeSingle();
  const isAuthor = !ownRowError && !!ownRow;
  let owned = isAuthor;
  if (!owned) {
    const { data: ownsBook, error: ownsBookError } = await supabase.rpc("user_owns_book", { target_book_id: id });
    owned = !ownsBookError && ownsBook === true;
  }
  if (!owned) return fail(403, "not_owned");

  // 1a: the cancel window, from the buyer's own states. Asked before any
  // file is read, so a declined open costs nothing and records nothing.
  if (!isAuthor && !readConfirmed(new URL(request.url).searchParams)) {
    const { data: states, error: statesError } = await supabase.rpc("my_purchase_download_states");
    const until = statesError ? undefined : parseMyDownloadStates(states).get(id)?.cancelOpenUntil;
    const windowOpen = statesError || (!!until && Date.parse(until) > Date.now());
    if (windowOpen) return fail(409, "confirm_needed");
  }

  const admin = createAdminClient();
  const { data: storageData, error: storageError } = await admin
    .from("books")
    .select("id, author_id, file_path")
    .eq("id", id)
    .maybeSingle();
  const storageRow = !storageError && isReadStorageRow(storageData, id) ? storageData : null;
  if (!storageRow) return fail(404, "unavailable");

  const chosen = await readDownloadFilePath(admin, {
    bookId: id,
    isAuthor,
    currentFilePath: typeof storageRow.file_path === "string" ? storageRow.file_path : null,
  });
  if (!chosen.ok) return fail(404, "unavailable");
  const filePath = chosen.filePath;
  if (!isOwnBookManuscriptPath(filePath, storageRow.author_id, id)) return fail(404, "unavailable");

  const { data: fileBlob, error: fileError } = await admin.storage.from(BOOK_MANUSCRIPTS_BUCKET).download(filePath);
  if (fileError || !fileBlob) return fail(404, "unavailable");

  const content = await buildReaderContent(Buffer.from(await fileBlob.arrayBuffer()), "owned");
  if (!content.available) return fail(404, "unavailable");

  // lbnp2: Librum's pages, read exactly as the download reads them (the
  // rights basis first: if it cannot be read, no pages, so a public-domain
  // book never shows a false ©). Best-effort, like the download: a missing
  // page is logged and the book still opens.
  let frontPage = "";
  let lastPage = "";
  try {
    const rights = await readRightsBasisForPages(admin, id);
    const pages = rights.ok
      ? await readLibrumPages(supabase, {
          bookId: id,
          buyer: !isAuthor && user.email ? { readerId: user.id, email: user.email } : null,
          siteOrigin: resolveSiteOrigin(),
          rights: rights.basis,
        })
      : null;
    if (pages) {
      frontPage = readerFrontPageHtml(pages.front);
      lastPage = readerLastPageHtml(pages.last);
      if (pages.buyerLineMissing) {
        console.warn("Read: opened the book without the buyer line", { bookId: id, readerId: user.id });
      }
    } else {
      console.warn("Read: opened the book without the Librum pages", {
        bookId: id,
        readerId: user.id,
        stage: rights.ok ? "missing_details" : "rights_read_failed",
      });
    }
  } catch {
    frontPage = "";
    lastPage = "";
    console.warn("Read: opened the book without the Librum pages", { bookId: id, readerId: user.id, stage: "unexpected_exception" });
  }

  // Audit r1 B2: the answer must fit in one response (Vercel: 4.5 MB)
  // BEFORE the open is recorded, or a buyer could lose the cancel right
  // and still get no book. A book that is too big records nothing.
  const body = JSON.stringify({
    bookId: id,
    title: book.title,
    author: resolveBookByline(book),
    mode: "owned",
    html: frontPage + content.html + lastPage,
    toc: content.toc,
    approximatePercent: 100,
  });
  if (Buffer.byteLength(body, "utf8") > MAX_READ_RESPONSE_BYTES) {
    console.warn("Read: the book is too big to open online", { bookId: id, readerId: user.id });
    return fail(413, "too_large");
  }

  if (!isAuthor) {
    const { error: recordError } = await admin.rpc("record_book_download", {
      p_reader_id: user.id,
      p_book_id: id,
      p_file_path: filePath,
    });
    if (recordError) {
      console.error("Read: the open record failed, no text sent", {
        bookId: id,
        readerId: user.id,
        code: recordError.code ?? null,
      });
      return fail(503, "record_failed");
    }
  }

  return new NextResponse(body, { headers: { ...NO_STORE, "Content-Type": "application/json" } });
}
