import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// NOTIFY-CLEANUP (Renato 11-20: Q1 a, Q2 a, Q3 a): the daily pre-order
// job deletes «Më njofto» requests that are finished, so they don't
// pile up forever. Kept 30 days, then deleted:
//   1. a request whose email went out (notified_at), 30 days after it;
//   2. a request whose pre-order was cancelled but whose email never
//      went out, 30 days after the cancel (book_cancelled_at);
//   3. a request still waiting on a book that came out (published_at)
//      and is not a pre-order now, 30 days after the book came out --
//      its release email can no longer go out (for example, the book
//      was taken down first).
// A request on a live or paused pre-order is never touched. A released
// book keeps its release_date (run_preorder_day sets only status and
// published_at), so "came out" is read from published_at. A paused
// pre-order (a suspension or a pending account deletion: status draft,
// its dates kept) never came out, so its published_at is null: the app
// lists a pre-order only on a book never published ("published_before",
// saveBookPricing writes a release day only where published_at is null).
// The database does not enforce that, so step 3 also skips any book
// whose release day is after the day it came out (a re-listing).
// A deleted
// reader or book already deletes its requests (ON DELETE CASCADE).
// The 30 days also keep the follower email's check safe: on release day
// sendNewBookEmails skips readers with any row of this pre-order.
// The Privacy page says the same («Kërkesat «Më njofto»»).
// Never throws; only counts are returned and logged, never an id.

type AdminClient = ReturnType<typeof createAdminClient>;

export const NOTIFY_REQUEST_KEEP_DAYS = 30;

export type NotifyCleanupCounts = { sent: number; cancelled: number; released: number };

const DAY_MS = 24 * 60 * 60 * 1000;

type Row = { book_id: string };
type StuckRow = {
  book_id: string;
  books: { status: string; release_date: string | null; published_at: string | null } | null;
};

/**
 * True when this book's release day is not after the day it came out
 * (with a day's margin: release_date is a Tirana day, published_at a
 * UTC time), i.e. the release_date belongs to the release itself.
 */
function releaseDayIsPast(book: { release_date: string | null; published_at: string | null }): boolean {
  if (book.release_date === null) return true;
  if (book.published_at === null) return false;
  const publishedAt = Date.parse(book.published_at);
  if (Number.isNaN(publishedAt)) return false;
  const margin = new Date(publishedAt + DAY_MS).toISOString().slice(0, 10);
  return book.release_date <= margin;
}

/** Deletes the finished requests; null counts for a step that failed. */
export async function deleteOldNotifyRequests(
  admin: AdminClient,
  now: Date = new Date(),
): Promise<{ [K in keyof NotifyCleanupCounts]: number | null }> {
  const cutoff = new Date(now.getTime() - NOTIFY_REQUEST_KEEP_DAYS * DAY_MS).toISOString();
  const counts: { [K in keyof NotifyCleanupCounts]: number | null } = { sent: null, cancelled: null, released: null };

  // 1. Sent more than 30 days ago.
  try {
    const { data, error } = await admin
      .from("preorder_notify_requests")
      .delete()
      .not("notified_at", "is", null)
      .lt("notified_at", cutoff)
      .select("book_id")
      .returns<Row[]>();
    if (error || !data) console.error("notify cleanup: the sent step failed", { code: error?.code ?? null });
    else counts.sent = data.length;
  } catch (stepError) {
    console.error("notify cleanup: the sent step failed", { error: stepError });
  }

  // 2. Cancelled more than 30 days ago, email never sent.
  try {
    const { data, error } = await admin
      .from("preorder_notify_requests")
      .delete()
      .is("notified_at", null)
      .not("book_cancelled_at", "is", null)
      .lt("book_cancelled_at", cutoff)
      .select("book_id")
      .returns<Row[]>();
    if (error || !data) console.error("notify cleanup: the cancelled step failed", { code: error?.code ?? null });
    else counts.cancelled = data.length;
  } catch (stepError) {
    console.error("notify cleanup: the cancelled step failed", { error: stepError });
  }

  // 3. Still waiting on a book that came out more than 30 days ago and
  //    is not a pre-order now (see the top for paused ones). The books
  //    are read first; the delete is limited to those books and to
  //    requests made before the cutoff, so a request made since is
  //    never caught.
  try {
    const { data: stuck, error: readError } = await admin
      .from("preorder_notify_requests")
      .select("book_id, books!inner(status, release_date, published_at)")
      .is("notified_at", null)
      .is("book_cancelled_at", null)
      .neq("books.status", "preorder")
      .lt("books.published_at", cutoff)
      .returns<StuckRow[]>();
    if (readError || !stuck) {
      console.error("notify cleanup: the released read failed", { code: readError?.code ?? null });
    } else {
      const bookIds = [...new Set(stuck.filter((r) => r.books && releaseDayIsPast(r.books)).map((r) => r.book_id))];
      if (bookIds.length === 0) {
        counts.released = 0;
      } else {
        const { data, error } = await admin
          .from("preorder_notify_requests")
          .delete()
          .in("book_id", bookIds)
          .is("notified_at", null)
          .is("book_cancelled_at", null)
          .lt("created_at", cutoff)
          .select("book_id")
          .returns<Row[]>();
        if (error || !data) console.error("notify cleanup: the released step failed", { code: error?.code ?? null });
        else counts.released = data.length;
      }
    }
  } catch (stepError) {
    console.error("notify cleanup: the released step failed", { error: stepError });
  }

  return counts;
}
