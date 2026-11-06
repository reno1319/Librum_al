import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { tiranaToday } from "@/lib/preorders";
import { finalFileReleasesNow, isListingTooLate, reviewKind } from "@/lib/preorder-staff";
import { todayReviewPriority, type TodayPreorderState } from "../../admin-landing-logic";

// ADMIN-2-TAKEDOWN (M2, R2): staff pages must show drafts and taken-down
// books. A staff session sees every book only once PEN-NAMES-2's contract
// step has added "Staff with reports.resolve can view every book" (13a);
// before that, only PUBLISHED books -- a report on a draft would read
// "Book unavailable". So the admin pages read book titles and takedown
// state with the service-role client, and ONLY after their own
// requireStaff(...) check has passed. Never import this from a page or
// action that has not checked staff first (the PEN-NAMES-2 static guard
// lists its callers).

export type StaffBookTitles = { ok: true; titleById: Map<string, string> } | { ok: false };

export async function readBookTitlesForStaff(bookIds: readonly string[]): Promise<StaffBookTitles> {
  const ids = Array.from(new Set(bookIds.filter(Boolean)));
  const titleById = new Map<string, string>();
  if (ids.length === 0) return { ok: true, titleById };
  const { data, error } = await createAdminClient()
    .from("books")
    .select("id, title")
    .in("id", ids)
    .returns<{ id: string; title: string }[]>();
  if (error) {
    console.error("readBookTitlesForStaff: read failed", { error });
    return { ok: false };
  }
  for (const book of data ?? []) titleById.set(book.id, book.title);
  return { ok: true, titleById };
}

/** The ids of every book with an ACTIVE takedown (a small set), or null on a read error. */
export async function readActiveTakedownBookIds(): Promise<Set<string> | null> {
  const { data, error } = await createAdminClient()
    .from("book_takedowns")
    .select("book_id")
    .is("lifted_at", null)
    .returns<{ book_id: string | null }[]>();
  if (error) {
    console.error("readActiveTakedownBookIds: read failed", { error });
    return null;
  }
  return new Set((data ?? []).map((row) => row.book_id).filter((id): id is string => id !== null));
}

// ADMIN-3-REVIEW: the ids of every book with a PENDING review (a small
// set: books waiting for staff), or null on a read error. Rows whose
// book is gone (book_id null) are never counted (M3).
export async function readPendingReviewBookIds(): Promise<Set<string> | null> {
  const { data, error } = await createAdminClient()
    .from("book_reviews")
    .select("book_id")
    .eq("status", "pending")
    .not("book_id", "is", null)
    .returns<{ book_id: string | null }[]>();
  if (error) {
    console.error("readPendingReviewBookIds: read failed", { error });
    return null;
  }
  return new Set((data ?? []).map((row) => row.book_id).filter((id): id is string => id !== null));
}

// PEOPLE-2 (N3, Renato's 4b): the ids of every account with an active
// suspension (a small set), for the "Suspended" badge on the books list
// and book page. Null on a read error: the badge is information only --
// Approve is refused by the database (LB464) either way.
export async function readSuspendedAuthorIds(): Promise<Set<string> | null> {
  const { data, error } = await createAdminClient()
    .from("account_suspensions")
    .select("user_id")
    .is("lifted_at", null)
    .returns<{ user_id: string }[]>();
  if (error) {
    console.error("readSuspendedAuthorIds: read failed", { error });
    return null;
  }
  return new Set((data ?? []).map((row) => row.user_id));
}

export type PendingReviewForStaff = {
  reviewId: string;
  bookId: string;
  title: string;
  penName: string | null;
  submittedAt: string;
  // BD16 P3 (D9): set for a pre-order listing or a pre-order's final file.
  preorder?: { state: TodayPreorderState; releaseDate: string };
};

// BD16 P3: at most this many waiting reviews are read to sort Today's
// list (the urgent pre-order items first, D9). Waiting reviews are few.
const PENDING_REVIEWS_READ_CAP = 500;

// ADMIN-3-REVIEW (I): Today's "waiting for review" items: the pending
// reviews and the pen name each book carries now. BD16 P3 (D9): an
// overdue pre-order's final file first, then pre-order final files and
// listings too late to approve, then the rest oldest first; at most
// `limit` items. overdue = how many final files wait past their day.
// Null on a read error (the page shows its own load error).
export async function readPendingReviewsForStaff(
  limit: number,
): Promise<{ items: PendingReviewForStaff[]; total: number; overdue: number } | null> {
  const admin = createAdminClient();
  const { data, error, count } = await admin
    .from("book_reviews")
    .select("id, book_id, book_title, submitted_at, file_path, release_date", { count: "exact" })
    .eq("status", "pending")
    .not("book_id", "is", null)
    .order("submitted_at", { ascending: true })
    .limit(PENDING_REVIEWS_READ_CAP)
    .returns<
      {
        id: string;
        book_id: string;
        book_title: string;
        submitted_at: string;
        file_path: string | null;
        release_date: string | null;
      }[]
    >();
  if (error) {
    console.error("readPendingReviewsForStaff: read failed", { error });
    return null;
  }
  const rows = data ?? [];
  type BookRow = {
    id: string;
    status: string;
    file_path: string | null;
    release_date: string | null;
    pen: { name: string } | null;
  };
  const bookById = new Map<string, BookRow>();
  if (rows.length > 0) {
    const { data: books, error: booksError } = await admin
      .from("books")
      .select("id, status, file_path, release_date, pen:pen_names!books_pen_name_id_fkey(name)")
      .in("id", rows.map((row) => row.book_id))
      .returns<BookRow[]>();
    if (booksError) {
      console.error("readPendingReviewsForStaff: books read failed", { error: booksError });
    }
    for (const book of books ?? []) bookById.set(book.id, book);
  }
  const today = tiranaToday();
  const all: PendingReviewForStaff[] = rows.map((row) => {
    const book = bookById.get(row.book_id);
    const item: PendingReviewForStaff = {
      reviewId: row.id,
      bookId: row.book_id,
      title: row.book_title,
      penName: book?.pen?.name ?? null,
      submittedAt: row.submitted_at,
    };
    if (book) {
      const kind = reviewKind({
        bookStatus: book.status,
        bookFilePath: book.file_path,
        reviewFilePath: row.file_path,
        reviewReleaseDate: row.release_date,
      });
      if (kind === "final_file" && book.release_date) {
        item.preorder = {
          state: finalFileReleasesNow(book.release_date, today) ? "overdue" : "final_file",
          releaseDate: book.release_date,
        };
      } else if (kind === "listing" && row.release_date) {
        item.preorder = {
          state: isListingTooLate({ releaseDate: row.release_date, hasFile: row.file_path !== null, today })
            ? "listing_too_late"
            : "listing",
          releaseDate: row.release_date,
        };
      }
    }
    return item;
  });
  // Stable: rows are oldest first already.
  const sorted = [...all].sort((a, b) => todayReviewPriority(a) - todayReviewPriority(b));
  return {
    items: sorted.slice(0, Math.max(0, limit)),
    total: count ?? rows.length,
    overdue: all.filter((item) => item.preorder?.state === "overdue").length,
  };
}

// ADMIN-3-REVIEW (M2): the rights half of the publish gate, for the
// staff Approve action -- the same newest-declaration read as
// getRightsDeclarationState() (src/lib/book-rights.ts), with the
// service-role client because a staff session cannot read another
// author's declarations. Three ways; fails closed.
export async function readRightsStateForStaff(bookId: string): Promise<"present" | "none" | "unavailable"> {
  const { data, error } = await createAdminClient()
    .from("book_rights_declarations")
    .select("book_id")
    .eq("book_id", bookId)
    .order("declared_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("readRightsStateForStaff: read failed", { bookId, code: error.code ?? null });
    return "unavailable";
  }
  return data ? "present" : "none";
}
