import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

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
};

// ADMIN-3-REVIEW (I): Today's "waiting for review" items, oldest first:
// the pending reviews and the pen name each book carries now. Null on a
// read error (the page shows its own load error).
export async function readPendingReviewsForStaff(limit: number): Promise<{ items: PendingReviewForStaff[]; total: number } | null> {
  const admin = createAdminClient();
  const { data, error, count } = await admin
    .from("book_reviews")
    .select("id, book_id, book_title, submitted_at", { count: "exact" })
    .eq("status", "pending")
    .not("book_id", "is", null)
    .order("submitted_at", { ascending: true })
    .limit(limit)
    .returns<{ id: string; book_id: string; book_title: string; submitted_at: string }[]>();
  if (error) {
    console.error("readPendingReviewsForStaff: read failed", { error });
    return null;
  }
  const rows = data ?? [];
  const penByBook = new Map<string, string>();
  if (rows.length > 0) {
    const { data: books, error: booksError } = await admin
      .from("books")
      .select("id, title, pen:pen_names(name)")
      .in("id", rows.map((row) => row.book_id))
      .returns<{ id: string; title: string; pen: { name: string } | null }[]>();
    if (booksError) {
      console.error("readPendingReviewsForStaff: books read failed", { error: booksError });
    }
    for (const book of books ?? []) if (book.pen?.name) penByBook.set(book.id, book.pen.name);
  }
  return {
    items: rows.map((row) => ({
      reviewId: row.id,
      bookId: row.book_id,
      title: row.book_title,
      penName: penByBook.get(row.book_id) ?? null,
      submittedAt: row.submitted_at,
    })),
    total: count ?? rows.length,
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
