import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractEpubSample } from "@/lib/epub-sample";
import { resolvePublicAuthorName } from "@/lib/author-name";
import {
  BOOK_MANUSCRIPTS_BUCKET,
  isOwnCanonicalBookManuscriptPath,
} from "@/lib/book-storage-path";
import type { Book, Profile } from "@/lib/types";

// LIBRUM 2.0 AUTHOR-1B: the JSON response's own "author" field resolves
// through resolvePublicAuthorName(). Only the resolved string ever
// leaves this route; the profile object itself never rides along in the
// response.
//
// LIBRUM 2.0 AUTHOR-1C: reads the safe public_author_profiles VIEW
// (migration 045, aliased back to `profiles`), not the base profiles
// table -- physically has no display_name column.
//
// MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: the row also returns its own `id`
// and `author_id`, so the stored manuscript key is checked against the
// row's own identity before the service-role client ever sees it.
type SampleBookRow = Pick<Book, "id" | "author_id" | "title" | "status" | "file_path"> & {
  profiles: Pick<Profile, "public_author_name"> | null;
};

// Anything but one plain row object for exactly the requested id, with
// string author_id/title/status, is treated as no row at all.
function isSampleBookRow(data: unknown, requestedId: string): data is SampleBookRow {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return false;
  }
  const row = data as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id === requestedId &&
    typeof row.author_id === "string" &&
    typeof row.title === "string" &&
    typeof row.status === "string"
  );
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
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const supabase = await createClient();
  const { data: bookData, error: bookError } = await supabase
    .from("books")
    .select("id, author_id, title, status, file_path, profiles:public_author_profiles(public_author_name)")
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
  if (!book || book.status !== "published" || !book.file_path) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  // MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: this response is public, and the
  // service-role client bypasses Storage RLS (storage-js also puts the key
  // into the request URL unencoded, so "../" would leave the bucket). Only
  // the exact key `<row author_id>/<row id>.epub` may be fetched; a
  // legacy or forged value gets the same controlled answer as an
  // unreadable manuscript, before any admin client, Storage request or
  // EPUB extraction, and without echoing the value.
  const filePath = book.file_path;
  if (!isOwnCanonicalBookManuscriptPath(filePath, book.author_id, book.id)) {
    return NextResponse.json({ error: "sample_unavailable" }, { status: 404 });
  }

  const admin = createAdminClient();
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

  return NextResponse.json({
    bookId: id,
    title: book.title,
    author: resolvePublicAuthorName(book.profiles),
    sections: sample.sections,
    approximatePercent: sample.approximatePercent,
  });
}
