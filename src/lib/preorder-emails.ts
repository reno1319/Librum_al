import "server-only";
import { after } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  EMAIL_BATCH_SIZE,
  emailSendingConfigured,
  preorderCancelledReaderEmail,
  preorderDateMovedReaderEmail,
  preorderReleasedReaderEmail,
  sendEmailBatch,
  sendNewBookEmails,
  sendPreorderCancelledAuthorEmail,
  sendPreorderDateMovedEmail,
  sendPreorderReleasedAuthorEmail,
} from "@/lib/email";
import type { PreorderDaySummary } from "@/lib/preorder-job";

// BD16 P5 (PLAN-BD16-r1 §1 "Më njofto", §3.5, Q4 a, D2): the pre-order
// emails. Best effort like every email: nothing here throws, and no
// address is ever logged.
//
// Readers ("Më njofto"). Each preorder_notify_requests row is one
// reader and one pre-order, and gets ONE email: the release email when
// the book came out, or the "cancelled" email when the pre-order ended
// (books_preorder_rules / admin_lift_suspension set book_cancelled_at).
// notified_at is that row's sent marker. A row is CLAIMED -- notified_at
// set by a conditional UPDATE ... WHERE notified_at IS NULL, returning
// the rows it changed -- right before its email is sent, so of two runs
// at once (an immediate send after a staff action, the daily job, the
// owner's button) only one gets each row: a second run finds nothing to
// claim. Never twice.
//
// r2 (audit F1-F3): a row is claimed only when its email can go out.
// Nothing is claimed without RESEND_API_KEY (F2). The rows are worked in
// chunks of at most EMAIL_BATCH_SIZE: the title and every address are
// resolved FIRST, and only the readers whose lookup answered are claimed
// (a failed read or a thrown lookup leaves the row for the next run,
// F1; a reader with no address is claimed and skipped). A batch Resend
// definitely refused (a refusal status: 400/401/403/422/429, see
// isDefiniteRefusal in email.ts) is UN-claimed -- only the rows this
// claim marked, matched by its own timestamp -- so the next run retries
// it (F3). r3 (G1): any other failure (no status, 5xx, dropped
// connection, a throw) may have gone out, so it stays claimed: a failure
// is at most a missed email, never a second one. r3 (G2): batches use
// permissive validation; an address Resend refuses on its own stays
// claimed and is never retried, so it can't block the queue.
// A reader who asks again after a cancel starts a fresh row
// (preorder_notify_me resets it).
//
// Every caller runs the same sweep over every waiting row, so whatever
// one run leaves (a crash, a refusal, a timed-out page) the next one sends.

type AdminClient = ReturnType<typeof createAdminClient>;

type ClaimedRow = { book_id: string; user_id: string };

export type ReaderEmailCounts = { released: number; cancelled: number };

// How many chunks one sweep works through (100 rows each); the rest wait
// for the next run.
export const READER_SWEEP_MAX_CHUNKS = 50;

type Lookup = { email: string } | "none" | "failed";

async function lookupEmail(admin: AdminClient, userId: string): Promise<Lookup> {
  try {
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error) return "failed";
    const email = data?.user?.email;
    return email ? { email } : "none";
  } catch {
    return "failed";
  }
}

// For the author's and the "new date" emails, which keep no mark.
async function emailsFor(admin: AdminClient, userIds: string[]): Promise<string[]> {
  const emails: string[] = [];
  for (let start = 0; start < userIds.length; start += EMAIL_BATCH_SIZE) {
    const found = await Promise.all(userIds.slice(start, start + EMAIL_BATCH_SIZE).map((id) => lookupEmail(admin, id)));
    for (const f of found) if (typeof f === "object") emails.push(f.email);
  }
  return emails;
}

/** Null when the read failed (nothing may be claimed then). */
async function titlesFor(admin: AdminClient, bookIds: string[]): Promise<Map<string, string> | null> {
  if (bookIds.length === 0) return new Map();
  try {
    const { data, error } = await admin
      .from("books")
      .select("id, title")
      .in("id", bookIds)
      .returns<{ id: string; title: string }[]>();
    if (error || !data) {
      console.error("preorder emails: the titles read failed", { code: error?.code ?? null });
      return null;
    }
    return new Map(data.map((b) => [b.id, b.title]));
  } catch {
    console.error("preorder emails: the titles read failed");
    return null;
  }
}

type ReaderKind = "released" | "cancelled";

/** Up to EMAIL_BATCH_SIZE unsent rows of this kind, oldest first. Null on a failed read. */
async function readChunk(admin: AdminClient, kind: ReaderKind): Promise<ClaimedRow[] | null> {
  const base = admin.from("preorder_notify_requests");
  // Released: only books that are published now; a pre-order still
  // waiting, or one that ended (book_cancelled_at set), is not touched.
  const query =
    kind === "released"
      ? base
          .select("book_id, user_id, books!inner(status)")
          .is("notified_at", null)
          .is("book_cancelled_at", null)
          .eq("books.status", "published")
      : base.select("book_id, user_id").is("notified_at", null).not("book_cancelled_at", "is", null);
  const { data, error } = await query
    .order("created_at", { ascending: true })
    .limit(EMAIL_BATCH_SIZE)
    .returns<ClaimedRow[]>();
  if (error || !data) {
    console.error(`preorder emails: the ${kind} read failed`, { code: error?.code ?? null });
    return null;
  }
  return data.map((r) => ({ book_id: r.book_id, user_id: r.user_id }));
}

/**
 * One book's readers in one chunk: claim the resolved ones, send, and
 * un-claim a definite refusal. sent: emails handed to Resend; settled:
 * rows that stay marked (sent, or a reader with no address).
 */
async function sendBookChunk(
  admin: AdminClient,
  kind: ReaderKind,
  bookId: string,
  title: string,
  lookups: Map<string, Lookup>,
): Promise<{ sent: number; settled: number }> {
  const none = { sent: 0, settled: 0 };
  const claimable = [...lookups].filter(([, l]) => l !== "failed").map(([userId]) => userId);
  if (claimable.length === 0) return none;

  const claimAt = new Date().toISOString();
  let claim = admin
    .from("preorder_notify_requests")
    .update({ notified_at: claimAt })
    .eq("book_id", bookId)
    .in("user_id", claimable)
    .is("notified_at", null);
  claim = kind === "released" ? claim.is("book_cancelled_at", null) : claim.not("book_cancelled_at", "is", null);
  const { data: claimed, error } = await claim.select("book_id, user_id").returns<ClaimedRow[]>();
  if (error || !claimed) {
    console.error(`preorder emails: the ${kind} claim failed`, { bookId, code: error?.code ?? null });
    return none;
  }

  const { subject, html } =
    kind === "released" ? preorderReleasedReaderEmail({ title, bookId }) : preorderCancelledReaderEmail({ title });
  const recipients: { userId: string; to: string }[] = [];
  for (const row of claimed) {
    const found = lookups.get(row.user_id);
    if (found && typeof found === "object") recipients.push({ userId: row.user_id, to: found.email });
  }
  if (recipients.length === 0) return { sent: 0, settled: claimed.length };

  // r3 (audit G1, G2): only a definite refusal is put back; a bad
  // address (invalid) stays marked and is never retried; an unknown
  // outcome stays marked too (it may have gone out).
  const { notSent, invalid } = await sendEmailBatch(
    recipients.map(({ to }) => ({ to, subject, html })),
    { permissive: true },
  );
  if (notSent.length > 0) {
    // F3: surely not sent, so back to unsent -- only rows this claim
    // marked (a later run's claim has another timestamp).
    const { error: undoError } = await admin
      .from("preorder_notify_requests")
      .update({ notified_at: null })
      .eq("book_id", bookId)
      .in(
        "user_id",
        notSent.map((i) => recipients[i].userId),
      )
      .eq("notified_at", claimAt)
      .select("book_id, user_id")
      .returns<ClaimedRow[]>();
    if (undoError) console.error(`preorder emails: the ${kind} un-claim failed`, { bookId, code: undoError.code ?? null });
  }
  return { sent: recipients.length - notSent.length - invalid.length, settled: claimed.length - notSent.length };
}

async function sweepKind(admin: AdminClient, kind: ReaderKind): Promise<number> {
  let sent = 0;
  for (let round = 0; round < READER_SWEEP_MAX_CHUNKS; round++) {
    const rows = await readChunk(admin, kind);
    if (!rows || rows.length === 0) break;

    const byBook = new Map<string, string[]>();
    for (const row of rows) byBook.set(row.book_id, [...(byBook.get(row.book_id) ?? []), row.user_id]);
    const titles = await titlesFor(admin, [...byBook.keys()]);
    if (!titles) break; // F1: nothing claimed; the next run tries again.

    let settled = 0;
    for (const [bookId, userIds] of byBook) {
      const title = titles.get(bookId);
      if (!title) continue; // gone since the read; nothing claimed
      const found = await Promise.all(userIds.map(async (id) => [id, await lookupEmail(admin, id)] as const));
      const result = await sendBookChunk(admin, kind, bookId, title, new Map<string, Lookup>(found));
      sent += result.sent;
      settled += result.settled;
    }
    // Stop when nothing in this chunk stayed marked (lookups failed, or a
    // refusal put them back) or it was the last one, so a refusal is
    // retried by the next run, not in a loop now (at most
    // READER_SWEEP_MAX_CHUNKS rounds either way).
    if (settled === 0 || rows.length < EMAIL_BATCH_SIZE) break;
  }
  return sent;
}

/** The readers' sweep: every unsent release and cancel email. */
export async function sendWaitingReaderEmails(admin: AdminClient): Promise<ReaderEmailCounts> {
  const counts: ReaderEmailCounts = { released: 0, cancelled: 0 };
  // F2: without a key nothing could go out, so nothing is marked.
  if (!emailSendingConfigured()) {
    console.warn("preorder emails: RESEND_API_KEY not set -- the readers' emails wait for a later run");
    return counts;
  }
  try {
    counts.cancelled = await sweepKind(admin, "cancelled");
  } catch (sendError) {
    console.error("preorder emails: the cancelled emails failed", { error: sendError });
  }
  try {
    counts.released = await sweepKind(admin, "released");
  } catch (sendError) {
    console.error("preorder emails: the released emails failed", { error: sendError });
  }
  return counts;
}

/**
 * After a staff or author action that may have released or ended a
 * pre-order (late final-file approval, takedown, the author's cancel, a
 * lift that cancels): the sweep runs once the page has answered, so a
 * long list never slows the action down. Never throws.
 */
export function scheduleWaitingReaderEmails(source: string): void {
  try {
    after(async () => {
      try {
        await sendWaitingReaderEmails(createAdminClient());
      } catch (sendError) {
        console.error(`${source}: the pre-order reader emails failed`, { error: sendError });
      }
    });
  } catch (scheduleError) {
    console.error(`${source}: the pre-order reader emails could not be scheduled`, { error: scheduleError });
  }
}

/**
 * Renato 11-06 (card): the one "new date" email to a pre-order's waiting
 * readers when its date moves. A pre-order's date moves at most once
 * (preorder_slip_used: the job's slip and the author's push are the
 * same one move, and the database refuses a second), and each move is
 * reported to exactly one caller -- the job run that applied it (in its
 * summary, under the job's lock) or the author's push action -- so the
 * event itself is the "sent once" guard; no per-reader mark is kept
 * (notified_at stays for the release or cancel email). The rows are
 * read, not claimed: a reader still waiting gets it; one who left or
 * was already told about a release or cancel does not. Never throws.
 */
export async function sendDateMovedReaderEmails(
  admin: AdminClient,
  { bookId, releaseDate }: { bookId: string; releaseDate: string },
): Promise<number> {
  try {
    const { data: waiting, error } = await admin
      .from("preorder_notify_requests")
      .select("book_id, user_id")
      .eq("book_id", bookId)
      .is("notified_at", null)
      .is("book_cancelled_at", null)
      .returns<ClaimedRow[]>();
    if (error) {
      console.error("preorder emails: the date-moved read failed", { bookId, code: error.code ?? null });
      return 0;
    }
    if (!waiting || waiting.length === 0) return 0;
    const title = (await titlesFor(admin, [bookId]))?.get(bookId);
    if (!title) return 0;
    const { subject, html } = preorderDateMovedReaderEmail({ title, bookId, releaseDate });
    const emails = await emailsFor(admin, waiting.map((r) => r.user_id));
    const { notSent, invalid } = await sendEmailBatch(
      emails.map((to) => ({ to, subject, html })),
      { permissive: true },
    );
    return emails.length - notSent.length - invalid.length;
  } catch (sendError) {
    console.error("preorder emails: the date-moved emails failed", { bookId, error: sendError });
    return 0;
  }
}

/** After the author's own push (the one move): readers hear once the page has answered. */
export function scheduleDateMovedReaderEmails(source: string, move: { bookId: string; releaseDate: string }): void {
  try {
    after(async () => {
      await sendDateMovedReaderEmails(createAdminClient(), move);
    });
  } catch (scheduleError) {
    console.error(`${source}: the date-moved emails could not be scheduled`, { error: scheduleError });
  }
}

type JobBook = { id: string; title: string; author_id: string; release_date: string | null };

async function authorEmail(admin: AdminClient, authorId: string): Promise<string | null> {
  const [email] = await emailsFor(admin, [authorId]);
  return email ?? null;
}

/**
 * The emails after the daily job's database step (the cron route and
 * the owner's button). Each book appears in a summary only in the run
 * that changed it, so the author's emails and the followers' email go
 * once; the readers' sweep runs even when the step failed (summary null).
 */
export async function sendPreorderJobEmails(
  admin: AdminClient,
  summary: PreorderDaySummary | null,
): Promise<ReaderEmailCounts> {
  if (summary) {
    const slippedIds = summary.slipped.map((s) => s.bookId);
    const ids = [...new Set([...summary.releasedBookIds, ...slippedIds, ...summary.cancelledBookIds])];
    let books = new Map<string, JobBook>();
    if (ids.length > 0) {
      try {
        const { data, error } = await admin
          .from("books")
          .select("id, title, author_id, release_date")
          .in("id", ids)
          .returns<JobBook[]>();
        if (error) console.error("preorder emails: the job books read failed", { code: error.code ?? null });
        books = new Map((data ?? []).map((b) => [b.id, b]));
      } catch (readError) {
        console.error("preorder emails: the job books read failed", { error: readError });
      }
    }

    const tellAuthor = async (bookId: string, send: (to: string, book: JobBook) => Promise<void>) => {
      const book = books.get(bookId);
      if (!book) return;
      try {
        const to = await authorEmail(admin, book.author_id);
        if (to) await send(to, book);
      } catch (sendError) {
        console.error("preorder emails: an author email failed", { bookId, error: sendError });
      }
    };

    for (const bookId of summary.releasedBookIds) {
      await tellAuthor(bookId, (to, book) => sendPreorderReleasedAuthorEmail(to, { title: book.title, bookId }));
    }
    for (const { bookId, releaseDate } of summary.slipped) {
      await tellAuthor(bookId, (to, book) => sendPreorderDateMovedEmail(to, { title: book.title, releaseDate }));
      await sendDateMovedReaderEmails(admin, { bookId, releaseDate });
    }
    for (const bookId of summary.cancelledBookIds) {
      await tellAuthor(bookId, (to, book) => sendPreorderCancelledAuthorEmail(to, { title: book.title }));
    }
    // D2: the pen name's followers hear at release only; sendNewBookEmails
    // leaves out the readers who asked "Më njofto" (they get theirs below).
    for (const bookId of summary.releasedBookIds) {
      const book = books.get(bookId);
      if (!book) continue;
      try {
        await sendNewBookEmails(admin, { bookId, authorId: book.author_id });
      } catch (sendError) {
        console.error("preorder emails: the followers email failed", { bookId, error: sendError });
      }
    }
  }
  return sendWaitingReaderEmails(admin);
}

// R22 (I3): an author who deletes their account takes their books with
// them, and the "Më njofto" rows go too (on delete cascade), so the
// readers' sweep above could never tell them. deleteAccount reads the
// unsent rows of the author's books BEFORE deleting anything (a failed
// read stops the deletion, like its other reads), then, only once the
// account is gone, sends each of those readers the "cancelled" email.
// The rows no longer exist, so there is no mark to set: this is one
// best-effort send, never retried, never twice (nothing is left for a
// later run to find). No address is logged.

export type WaitingReadersRead =
  | { ok: true; byBook: Map<string, { title: string; userIds: string[] }> }
  | { ok: false };

type WaitingRow = { book_id: string; user_id: string; books: { title: string } | null };

/** Every unsent "Më njofto" row of these books, by book. ok:false on a failed read. */
export async function readWaitingReadersForBooks(
  admin: AdminClient,
  bookIds: readonly string[],
): Promise<WaitingReadersRead> {
  const byBook = new Map<string, { title: string; userIds: string[] }>();
  const ids = Array.from(new Set(bookIds));
  if (ids.length === 0) return { ok: true, byBook };
  try {
    const { data, error } = await admin
      .from("preorder_notify_requests")
      .select("book_id, user_id, books!inner(title)")
      .in("book_id", ids)
      .is("notified_at", null)
      .returns<WaitingRow[]>();
    if (error || !Array.isArray(data)) {
      console.error("preorder emails: the deleted books' readers read failed", { code: error?.code ?? null });
      return { ok: false };
    }
    for (const row of data) {
      if (!ids.includes(row.book_id) || !row.books?.title) return { ok: false };
      const entry = byBook.get(row.book_id) ?? { title: row.books.title, userIds: [] };
      entry.userIds.push(row.user_id);
      byBook.set(row.book_id, entry);
    }
    return { ok: true, byBook };
  } catch {
    console.error("preorder emails: the deleted books' readers read failed");
    return { ok: false };
  }
}

/** The "cancelled" email to readers read by readWaitingReadersForBooks. Never throws. */
export async function sendDeletedBooksCancelledEmails(
  admin: AdminClient,
  waiting: Map<string, { title: string; userIds: string[] }>,
): Promise<number> {
  if (waiting.size === 0) return 0;
  if (!emailSendingConfigured()) {
    console.warn("preorder emails: RESEND_API_KEY not set -- the deleted books' readers were not told");
    return 0;
  }
  let sent = 0;
  for (const [bookId, { title, userIds }] of waiting) {
    try {
      const { subject, html } = preorderCancelledReaderEmail({ title });
      const emails = await emailsFor(admin, userIds);
      const { notSent, invalid } = await sendEmailBatch(
        emails.map((to) => ({ to, subject, html })),
        { permissive: true },
      );
      sent += emails.length - notSent.length - invalid.length;
    } catch (sendError) {
      console.error("preorder emails: a deleted book's cancelled emails failed", { bookId, error: sendError });
    }
  }
  return sent;
}

/** After the account is deleted: send once the page has answered. Never throws. */
export function scheduleDeletedBooksCancelledEmails(
  source: string,
  waiting: Map<string, { title: string; userIds: string[] }>,
): void {
  if (waiting.size === 0) return;
  try {
    after(async () => {
      try {
        await sendDeletedBooksCancelledEmails(createAdminClient(), waiting);
      } catch (sendError) {
        console.error(`${source}: the deleted books' cancelled emails failed`, { error: sendError });
      }
    });
  } catch (scheduleError) {
    console.error(`${source}: the deleted books' cancelled emails could not be scheduled`, { error: scheduleError });
  }
}
