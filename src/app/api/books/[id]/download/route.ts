import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { watermarkEpub } from "@/lib/watermark";
import { isRecoverySessionActive } from "@/lib/recovery-session";
import {
  BOOK_MANUSCRIPTS_BUCKET,
  isOwnBookManuscriptPath,
} from "@/lib/book-storage-path";
import { readDownloadFilePath } from "@/lib/book-reviews";
import { downloadFileName } from "@/lib/download-file-name";
import { addLibrumPages } from "@/lib/epub-librum-pages";
import { readLibrumPages } from "@/lib/librum-download-pages";
import { readRightsBasisForPages } from "@/lib/librum-download-rights";
import { resolveSiteOrigin } from "@/lib/site-url";

// MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: the exact row this route may act
// on. `id` and `author_id` come back from the database with the path so
// the manuscript key is checked against the row's own identity, never
// against the URL parameter alone and never against anything parsed out
// of the stored path. `file_path` stays `unknown` here on purpose: it is
// data, not authority, until isOwnBookManuscriptPath() accepts it.
//
// PEN-NAMES-2 (D2): entitlement is decided first (own book by an own-row
// query, or user_owns_book), from the public row (public_books: id and
// title only). Only then does a service-role read fetch author_id and
// file_path; neither ever leaves this route.
type DownloadBookRow = {
  id: string;
  author_id: string;
  title: string;
  file_path: unknown;
};

// Anything but one plain row object whose id is exactly the requested id
// and whose author_id/title are strings is treated as no row at all.
function toDownloadBookRow(data: unknown, requestedId: string): DownloadBookRow | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  const row = data as Record<string, unknown>;
  if (
    typeof row.id !== "string" ||
    row.id !== requestedId ||
    typeof row.author_id !== "string" ||
    typeof row.title !== "string"
  ) {
    return null;
  }
  return { id: row.id, author_id: row.author_id, title: row.title, file_path: row.file_path };
}

// DOWNLOADS-1: Next.js answers HEAD by running GET when a route has no
// HEAD of its own -- here that would write a download row (ending the
// buyer's 14-day cancel right) for a request that receives no file. So
// HEAD is refused outright and touches nothing.
export function HEAD() {
  return new NextResponse(null, { status: 405, headers: { Allow: "GET" } });
}

// Manuscripts live in a private storage bucket. Nobody gets a permanent
// link to them — this route checks ownership on every request, then
// streams back a copy watermarked with the downloader's email.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // LAUNCH-1 P1-11: defense-in-depth -- Proxy already blocks this route
  // while a recovery session is active (its matcher covers /api/*), so
  // this is the second layer against a crafted direct request. A 403
  // JSON response, not a redirect: this endpoint hands back a file, not
  // a page, and redirect semantics would be misleading for a
  // programmatic/download client -- see the P1-11 audit's own
  // conclusion on this specific boundary.
  const cookieStore = await cookies();
  if (isRecoverySessionActive(cookieStore)) {
    return NextResponse.json(
      { error: "Përfundoni ndryshimin e fjalëkalimit para se të shkarkoni." },
      { status: 403 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL(`/login?next=/libra/${id}`, request.url));
  }

  const fileUnavailable = () =>
    NextResponse.redirect(new URL(`/libra/${id}?error=${encodeURIComponent("Ky skedar nuk është i disponueshëm.")}`, request.url));

  // MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: a query error fails closed even
  // when plausible row data rides along with it. The stored path is NOT
  // inspected here -- that happens only after the entitlement decision
  // below, so a caller who may not download this book learns nothing
  // about whether its manuscript path is valid, present or absent.
  const { data: publicData, error: publicError } = await supabase
    .from("public_books")
    .select("id")
    .eq("id", id)
    .maybeSingle<{ id: string }>();
  if (publicError || !publicData || publicData.id !== id) {
    return fileUnavailable();
  }

  // LAUNCH-1 P1-7A: user_owns_book() now also excludes a purchase whose
  // payment intent has a dispute at status 'lost' (see migration 035) --
  // routed through this RPC rather than a raw purchases select, since
  // public.payment_disputes is fully closed to the request-scoped
  // client and this SECURITY DEFINER function already encapsulates the
  // complete, correct ownership predicate.
  const { data: ownRow, error: ownRowError } = await supabase
    .from("books")
    .select("id")
    .eq("id", id)
    .eq("author_id", user.id)
    .maybeSingle();
  let owned = !ownRowError && !!ownRow;
  if (!owned) {
    const { data: ownsBook, error: ownsBookError } = await supabase.rpc("user_owns_book", {
      target_book_id: id,
    });
    owned = !ownsBookError && ownsBook === true;
  }

  if (!owned) {
    return NextResponse.redirect(
      new URL(`/libra/${id}?error=${encodeURIComponent("Blini këtë libër për ta shkarkuar.")}`, request.url),
    );
  }

  // Entitled: the service role reads the manuscript key and its owner.
  const admin = createAdminClient();
  const { data: bookData, error: bookError } = await admin
    .from("books")
    .select("id, author_id, file_path, title")
    .eq("id", id)
    .maybeSingle();

  const book = bookError ? null : toDownloadBookRow(bookData, id);
  if (!book) {
    return fileUnavailable();
  }

  // ADMIN-3-REVIEW (N2 ★a, P3): which file. The author always gets the
  // current file; a buyer gets the file of the book's latest APPROVED
  // review (so a new file waiting for review never reaches buyers before
  // Librum approves it), or the current file when the book has never had
  // an approval. Read with the same service-role client; any read error
  // fails CLOSED -- never the current file as a fallback.
  const chosen = await readDownloadFilePath(admin, {
    bookId: book.id,
    isAuthor: book.author_id === user.id,
    currentFilePath: typeof book.file_path === "string" ? book.file_path : null,
  });
  if (!chosen.ok) {
    return fileUnavailable();
  }

  // MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: the service-role client bypasses
  // Storage RLS, and storage-js interpolates the key into the request URL
  // unencoded (a "../" segment would leave the bucket). So nothing reaches
  // it unless the chosen value is exactly `<row author_id>/<row id>.epub`
  // or (ADMIN-3) `<row author_id>/<row id>/<uuid>.epub`. A missing,
  // legacy or forged value gets the same file-unavailable answer as a
  // missing row, with nothing logged or echoed.
  const filePath = chosen.filePath;
  if (!isOwnBookManuscriptPath(filePath, book.author_id, book.id)) {
    return fileUnavailable();
  }

  const { data: fileBlob, error: downloadError } = await admin.storage
    .from(BOOK_MANUSCRIPTS_BUCKET)
    .download(filePath);

  if (downloadError || !fileBlob) {
    return NextResponse.redirect(
      new URL(`/libra/${id}?error=${encodeURIComponent("Skedari nuk u shkarkua dot.")}`, request.url),
    );
  }

  const storedBytes = Buffer.from(await fileBlob.arrayBuffer());

  // BD3 + BD4 + BD4b (Renato 1 Nov): the Librum copyright page (with
  // the buyer line) at the front and the "more by this author" page at
  // the end, added on the way out so they always show the current book
  // details; the stored file is never changed. Fail-open like the email
  // mark below: the reader always gets the book, and this route logs
  // the fallback once, with opaque ids and a stage tag only.
  let originalBytes: Buffer = storedBytes;
  try {
    const isAuthor = book.author_id === user.id;
    // BD3 patch 3: the rights basis decides the © line. If it can't be
    // read, no pages at all (audit r1, N3): a public-domain book must
    // never get a false ©.
    const rights = await readRightsBasisForPages(admin, book.id);
    const pages = rights.ok
      ? await readLibrumPages(supabase, {
          bookId: book.id,
          buyer: !isAuthor && user.email ? { readerId: user.id, email: user.email } : null,
          siteOrigin: resolveSiteOrigin(),
          rights: rights.basis,
        })
      : null;
    if (!pages) {
      console.warn("Download: served the book without the Librum pages (fallback)", {
        bookId: id,
        readerId: user.id,
        stage: rights.ok ? "missing_details" : "rights_read_failed",
      });
    } else {
      if (pages.buyerLineMissing) {
        console.warn("Download: added the Librum pages without the buyer line", {
          bookId: id,
          readerId: user.id,
          stage: "missing_purchase_row",
        });
      }
      const added = await addLibrumPages(storedBytes, pages);
      if (added.added) {
        originalBytes = added.bytes;
      } else {
        const log = added.failureStage === "unexpected_exception" ? console.error : console.warn;
        log("Download: served the book without the Librum pages (fallback)", {
          bookId: id,
          readerId: user.id,
          byteSize: storedBytes.length,
          stage: added.failureStage,
        });
      }
    }
  } catch {
    console.error("Download: served the book without the Librum pages (fallback)", {
      bookId: id,
      readerId: user.id,
      stage: "unexpected_exception",
    });
  }

  // LAUNCH-1 P3-2: watermarking is fail-open by design -- the reader
  // must always get their purchased EPUB, watermarked or not. This
  // route is the SOLE logging boundary for that fallback (watermark.ts
  // itself never logs) -- exactly one warn/error per fallback, never
  // both, and never for a successful watermark. Every log line below
  // stays deliberately narrow: bookId/readerId (opaque ids, not email),
  // byte size, and a small failure-stage tag -- never the manuscript
  // contents, the container/OPF XML, the storage path, or the reader's
  // email itself.
  let fileBytes: Buffer;
  if (!user.email) {
    // watermarkEpub is never invoked here at all (no email to embed),
    // so this is a route-level fallback stage, not a WatermarkFailureStage.
    console.warn("Download: served an unwatermarked EPUB (fallback)", {
      bookId: id,
      readerId: user.id,
      byteSize: originalBytes.length,
      stage: "missing_reader_email",
    });
    fileBytes = originalBytes;
  } else {
    const watermarkResult = await watermarkEpub(originalBytes, user.email);
    if (!watermarkResult.watermarked) {
      const log =
        watermarkResult.failureStage === "unexpected_exception" ? console.error : console.warn;
      log("Download: served an unwatermarked EPUB (fallback)", {
        bookId: id,
        readerId: user.id,
        byteSize: originalBytes.length,
        stage: watermarkResult.failureStage,
      });
    }
    fileBytes = watermarkResult.bytes;
  }

  // DOWNLOADS-1 (1a): a buyer's download is recorded BEFORE the file is
  // sent, with the exact key served (which version), and a failed
  // record sends no file -- the 14-day cancel right ends at the first
  // download, so there is never a download without its row.
  // record_book_download() re-checks the active purchase itself (under
  // a lock on the purchase row). The author's own download is not a
  // purchase and is not recorded. The log line carries opaque ids and
  // the error code only.
  if (book.author_id !== user.id) {
    const { error: recordError } = await admin.rpc("record_book_download", {
      p_reader_id: user.id,
      p_book_id: book.id,
      p_file_path: filePath,
    });
    if (recordError) {
      console.error("Download: the download record failed, no file sent", {
        bookId: id,
        readerId: user.id,
        code: recordError.code ?? null,
      });
      return NextResponse.redirect(
        new URL(`/libra/${id}?error=${encodeURIComponent("Skedari nuk u shkarkua dot. Provoni përsëri.")}`, request.url),
      );
    }
  }

  const fileName = downloadFileName(book.title);

  return new NextResponse(new Uint8Array(fileBytes), {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(fileBytes.length),
    },
  });
}
