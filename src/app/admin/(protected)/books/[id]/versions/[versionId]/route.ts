import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { BOOK_MANUSCRIPTS_BUCKET } from "@/lib/book-storage-path";
import { readEarlierBookFilePath } from "@/lib/book-file-versions";
import { isUuid } from "../../../book-admin-logic";

// FV1 (fv2 a): "Download" on an earlier file on the staff book page.
// requireStaff("books.review") first (owner and admin, like "Open the
// book file"); then the service-role client reads the book and the
// version row, which must be this book's, already replaced, and the
// book's own key (checked before any Storage call). Hands back a
// short-lived signed URL (5 minutes). Never cached.

const SIGNED_URL_SECONDS = 300;
const FILE_UNAVAILABLE_MESSAGE = "That file isn't available.";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function redirectTo(url: URL | string): NextResponse {
  const response = NextResponse.redirect(url);
  for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
  return response;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string; versionId: string }> }) {
  // Outside any try/catch: requireStaff redirects on its own.
  await requireStaff("books.review");

  const { id, versionId } = await params;
  if (!isUuid(id)) return redirectTo(new URL(`/admin/books?error=${encodeURIComponent(FILE_UNAVAILABLE_MESSAGE)}`, request.url));
  const unavailable = () =>
    redirectTo(new URL(`/admin/books/${id}?error=${encodeURIComponent(FILE_UNAVAILABLE_MESSAGE)}`, request.url));
  if (!isUuid(versionId)) return unavailable();

  const admin = createAdminClient();
  const { data: book, error: bookError } = await admin
    .from("books")
    .select("id, author_id")
    .eq("id", id)
    .maybeSingle<{ id: string; author_id: string }>();
  if (bookError || !book || book.id !== id) return unavailable();

  const version = await readEarlierBookFilePath(admin, { id: book.id, authorId: book.author_id }, versionId);
  if (version.kind !== "ok") return unavailable();

  const { data: signed, error: signError } = await admin.storage
    .from(BOOK_MANUSCRIPTS_BUCKET)
    .createSignedUrl(version.filePath, SIGNED_URL_SECONDS, { download: true });
  if (signError || !signed?.signedUrl) return unavailable();

  return redirectTo(signed.signedUrl);
}
