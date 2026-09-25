import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { watermarkEpub } from "@/lib/watermark";
import { isRecoverySessionActive } from "@/lib/recovery-session";
import {
  BOOK_MANUSCRIPTS_BUCKET,
  isOwnCanonicalBookManuscriptPath,
} from "@/lib/book-storage-path";

// MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: the exact row this route may act
// on. `id` and `author_id` come back from the database with the path so
// the manuscript key is checked against the row's own identity, never
// against the URL parameter alone and never against anything parsed out
// of the stored path. `file_path` stays `unknown` here on purpose: it is
// data, not authority, until isOwnCanonicalBookManuscriptPath() accepts it.
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
      { error: "Finish resetting your password before downloading." },
      { status: 403 },
    );
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.redirect(new URL(`/login?next=/books/${id}`, request.url));
  }

  const fileUnavailable = () =>
    NextResponse.redirect(new URL(`/books/${id}?error=That+file+isn%27t+available`, request.url));

  // MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: a query error fails closed even
  // when plausible row data rides along with it. The stored path is NOT
  // inspected here -- that happens only after the entitlement decision
  // below, so a caller who may not download this book learns nothing
  // about whether its manuscript path is valid, present or absent.
  const { data: bookData, error: bookError } = await supabase
    .from("books")
    .select("id, author_id, file_path, title")
    .eq("id", id)
    .single();

  const book = bookError ? null : toDownloadBookRow(bookData, id);
  if (!book) {
    return fileUnavailable();
  }

  // LAUNCH-1 P1-7A: user_owns_book() now also excludes a purchase whose
  // payment intent has a dispute at status 'lost' (see migration 035) --
  // routed through this RPC rather than a raw purchases select, since
  // public.payment_disputes is fully closed to the request-scoped
  // client and this SECURITY DEFINER function already encapsulates the
  // complete, correct ownership predicate.
  let owned = book.author_id === user.id;
  if (!owned) {
    const { data: ownsBook, error: ownsBookError } = await supabase.rpc("user_owns_book", {
      target_book_id: book.id,
    });
    owned = !ownsBookError && ownsBook === true;
  }

  if (!owned) {
    return NextResponse.redirect(
      new URL(`/books/${id}?error=Buy+this+book+to+download+it`, request.url),
    );
  }

  // MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: the service-role client bypasses
  // Storage RLS, and storage-js interpolates the key into the request URL
  // unencoded (a "../" segment would leave the bucket). So nothing reaches
  // it unless the stored value is exactly `<row author_id>/<row id>.epub`.
  // A missing, legacy or forged value gets the same file-unavailable
  // answer as a missing row, with nothing logged or echoed.
  const filePath = book.file_path;
  if (!isOwnCanonicalBookManuscriptPath(filePath, book.author_id, book.id)) {
    return fileUnavailable();
  }

  const admin = createAdminClient();
  const { data: fileBlob, error: downloadError } = await admin.storage
    .from(BOOK_MANUSCRIPTS_BUCKET)
    .download(filePath);

  if (downloadError || !fileBlob) {
    return NextResponse.redirect(
      new URL(`/books/${id}?error=Could+not+download+that+file`, request.url),
    );
  }

  const originalBytes = Buffer.from(await fileBlob.arrayBuffer());

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

  const fileName = `${book.title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.epub`;

  return new NextResponse(new Uint8Array(fileBytes), {
    headers: {
      "Content-Type": "application/epub+zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(fileBytes.length),
    },
  });
}
