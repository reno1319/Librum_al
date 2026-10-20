import { NextResponse } from "next/server";
import { requireStaff } from "@/lib/staff";
import { createAdminClient } from "@/lib/supabase/admin";
import { BOOK_MANUSCRIPTS_BUCKET, isOwnBookManuscriptPath } from "@/lib/book-storage-path";
import { isUuid } from "../../book-admin-logic";

// ADMIN-3-REVIEW (H, S6): "Open the book file" for a book waiting for
// review. requireStaff("books.review") first (owner and admin); then the
// service-role client reads the review and the book, and hands back a
// short-lived signed URL (5 minutes) for the review's snapshot file --
// only while the review is still pending AND its snapshot is the book's
// current file_path, so staff always open exactly the file they are
// approving. The key is classified against the book's own author and id
// (canonical or versioned) before any Storage call. Never cached.

const SIGNED_URL_SECONDS = 300;
const AUTHOR_CHANGED_FILE_MESSAGE = "The author changed the file. Reload.";
const FILE_UNAVAILABLE_MESSAGE = "That file isn't available.";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

function backToBook(request: Request, bookId: string | null, message: string): NextResponse {
  const path = bookId ? `/admin/books/${bookId}` : "/admin/books";
  const response = NextResponse.redirect(new URL(`${path}?error=${encodeURIComponent(message)}`, request.url));
  for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
  return response;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  // Outside any try/catch: requireStaff redirects on its own.
  await requireStaff("books.review");

  const { id } = await params;
  const reviewId = new URL(request.url).searchParams.get("review");
  if (!isUuid(id)) return backToBook(request, null, FILE_UNAVAILABLE_MESSAGE);
  if (!isUuid(reviewId)) return backToBook(request, id, FILE_UNAVAILABLE_MESSAGE);

  const admin = createAdminClient();
  const [{ data: review, error: reviewError }, { data: book, error: bookError }] = await Promise.all([
    admin
      .from("book_reviews")
      .select("id, book_id, status, file_path")
      .eq("id", reviewId)
      .maybeSingle<{ id: string; book_id: string | null; status: string; file_path: string | null }>(),
    admin
      .from("books")
      .select("id, author_id, file_path")
      .eq("id", id)
      .maybeSingle<{ id: string; author_id: string; file_path: string | null }>(),
  ]);
  if (reviewError || bookError || !review || !book || review.book_id !== book.id || review.status !== "pending") {
    return backToBook(request, id, FILE_UNAVAILABLE_MESSAGE);
  }
  if (review.file_path !== book.file_path) {
    return backToBook(request, id, AUTHOR_CHANGED_FILE_MESSAGE);
  }
  const filePath = review.file_path;
  if (!isOwnBookManuscriptPath(filePath, book.author_id, book.id)) {
    return backToBook(request, id, FILE_UNAVAILABLE_MESSAGE);
  }

  const { data: signed, error: signError } = await admin.storage
    .from(BOOK_MANUSCRIPTS_BUCKET)
    .createSignedUrl(filePath, SIGNED_URL_SECONDS, { download: true });
  if (signError || !signed?.signedUrl) {
    return backToBook(request, id, FILE_UNAVAILABLE_MESSAGE);
  }

  const response = NextResponse.redirect(signed.signedUrl);
  for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
  return response;
}
