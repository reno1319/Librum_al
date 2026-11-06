import "server-only";
import type { createClient } from "@/lib/supabase/server";
import type { createAdminClient } from "@/lib/supabase/admin";
import { BOOK_MANUSCRIPTS_BUCKET, isOwnBookManuscriptPath } from "@/lib/book-storage-path";
import {
  AUTHOR_REVIEW_COLUMNS,
  buildAuthorReviewNotices,
  type AuthorReviewNotice,
  type AuthorReviewRow,
  type AuthorSentBackNotice,
  type BookReviewStatus,
} from "@/lib/book-review-copy";

// ADMIN-3-REVIEW: the reads and writes of public.book_reviews
// (migration 20261020120000) that the author actions, the download
// route, deleteBook, account deletion and the staff pages share.
//
//   * Author side: always the AUTHOR'S OWN session client. The RPCs
//     (request_book_review, withdraw_book_review, book_review_state)
//     check ownership themselves; the table read names
//     AUTHOR_REVIEW_COLUMNS only (R1) and RLS shows own rows only.
//   * Trusted side: a service-role client the CALLER passes in, after
//     its own authentication and ownership checks -- the review paths
//     (file_path/cover_path) are never granted to authenticated. This
//     module creates no client itself, so the catalog writer stays
//     imported by the two dashboard action modules only.

type SessionClient = Awaited<ReturnType<typeof createClient>>;
type ServiceClient = ReturnType<typeof createAdminClient>;

// ------------------------------------------------------------
// Author side
// ------------------------------------------------------------

/** book_review_state(), three ways: a read error never reads as "approved". */
export type BookReviewState =
  | { kind: "ok"; pending: boolean; approvalValid: boolean; latestSentBack: AuthorSentBackNotice | null }
  | { kind: "unavailable" };

type RawReviewState = {
  pending?: unknown;
  approval_valid?: unknown;
  latest_sent_back?: { reason?: unknown; message?: unknown; decided_at?: unknown } | null;
};

export async function getBookReviewState(supabase: SessionClient, bookId: string): Promise<BookReviewState> {
  const { data, error } = await supabase.rpc("book_review_state", { p_book_id: bookId });
  if (error || data === null || typeof data !== "object") {
    console.error("getBookReviewState: read failed", { bookId, code: error?.code ?? null });
    return { kind: "unavailable" };
  }
  const raw = data as RawReviewState;
  if (typeof raw.pending !== "boolean" || typeof raw.approval_valid !== "boolean") {
    return { kind: "unavailable" };
  }
  const sent = raw.latest_sent_back;
  const latestSentBack =
    sent && typeof sent.reason === "string" && typeof sent.message === "string" && typeof sent.decided_at === "string"
      ? { reason: sent.reason, message: sent.message, sentBackAt: sent.decided_at }
      : null;
  return { kind: "ok", pending: raw.pending, approvalValid: raw.approval_valid, latestSentBack };
}

// BD15 P5a (audit r1, F4): a step that failed without a database code
// of its own (a storage rewrite, a helper that only reports "error")
// asks this afterwards: a book now waiting for review was sent from
// another tab, and the author is told so instead of a generic failure.
export async function isWaitingForReview(supabase: SessionClient, bookId: string): Promise<boolean> {
  const state = await getBookReviewState(supabase, bookId);
  return state.kind === "ok" && state.pending;
}

export type RequestBookReviewResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "already_pending"
        | "already_approved"
        | "already_published"
        | "taken_down"
        | "incomplete"
        // BD15 P5b-2: a live book with no waiting changes (LB494), or a
        // waiting 18+ label beside a children/teen category (LB493).
        | "nothing_to_send"
        | "adult_category"
        // BD16 P2 (migration 20261106120000): a pre-order listing's date
        // is not 14 days to 6 months ahead (LB500), the book has had its
        // 2 pre-orders (LB501), or it is a public-domain book (LB502).
        | "preorder_date"
        | "preorder_used_up"
        | "preorder_public_domain"
        | "not_found"
        | "failed";
    };

// request_book_review()'s own refusals, by message (P0001) or SQLSTATE.
export async function requestBookReview(supabase: SessionClient, bookId: string): Promise<RequestBookReviewResult> {
  const { error } = await supabase.rpc("request_book_review", { p_book_id: bookId });
  if (!error) return { ok: true };
  if (error.code === "LB460") return { ok: false, reason: "taken_down" };
  // BD15 P5a: no manuscript, no cover or no "AI used" answer (LB489).
  if (error.code === "LB489") return { ok: false, reason: "incomplete" };
  if (error.code === "LB494") return { ok: false, reason: "nothing_to_send" };
  if (error.code === "LB493") return { ok: false, reason: "adult_category" };
  if (error.code === "LB500") return { ok: false, reason: "preorder_date" };
  if (error.code === "LB501") return { ok: false, reason: "preorder_used_up" };
  if (error.code === "LB502") return { ok: false, reason: "preorder_public_domain" };
  const message = typeof error.message === "string" ? error.message : "";
  if (message === "this book is already waiting for review") return { ok: false, reason: "already_pending" };
  if (message === "this book is already approved") return { ok: false, reason: "already_approved" };
  if (message === "this book is already published") return { ok: false, reason: "already_published" };
  if (message === "no book found for this id") return { ok: false, reason: "not_found" };
  console.error("requestBookReview: request failed", { bookId, code: error.code ?? null });
  return { ok: false, reason: "failed" };
}

// BD15 P5a: a book waiting for review is read-only (LB490): its content
// columns, contributors and "AI used" answer refuse every write until
// the author cancels the review.
export const IN_REVIEW_LOCK_SQLSTATE = "LB490";

export function isInReviewLockError(error: { code?: string | null } | null | undefined): boolean {
  return error?.code === IN_REVIEW_LOCK_SQLSTATE;
}

export type WithdrawBookReviewResult = { ok: true } | { ok: false; reason: "not_pending" | "failed" };

export async function withdrawBookReview(supabase: SessionClient, bookId: string): Promise<WithdrawBookReviewResult> {
  const { error } = await supabase.rpc("withdraw_book_review", { p_book_id: bookId });
  if (!error) return { ok: true };
  if (error.message === "this book is not waiting for review") return { ok: false, reason: "not_pending" };
  console.error("withdrawBookReview: withdraw failed", { bookId, code: error.code ?? null });
  return { ok: false, reason: "failed" };
}

// N9: the Dashboard's chips and send-back notices -- ONE read of the
// author's own review rows (granted columns only). Display only, so a
// failed read shows nothing (logged); the publish gate decides on its
// own.
export async function loadAuthorReviewNotices(
  supabase: SessionClient,
  authorId: string,
): Promise<Map<string, AuthorReviewNotice>> {
  const { data, error } = await supabase
    .from("book_reviews")
    .select(AUTHOR_REVIEW_COLUMNS)
    .eq("author_id", authorId)
    .not("book_id", "is", null)
    .returns<AuthorReviewRow[]>();
  if (error) {
    console.error("loadAuthorReviewNotices: read failed", { code: error.code ?? null });
    return new Map();
  }
  return buildAuthorReviewNotices(data ?? []);
}

// ------------------------------------------------------------
// Trusted side: snapshots
// ------------------------------------------------------------

export type ReviewSnapshot = {
  id: string;
  book_id: string;
  status: BookReviewStatus;
  file_path: string | null;
  cover_path: string | null;
  submitted_at: string;
  decided_at: string | null;
};

export const REVIEW_SNAPSHOT_COLUMNS = "id, book_id, status, file_path, cover_path, submitted_at, decided_at";

export type ReviewSnapshotRead = { ok: true; byBook: Map<string, ReviewSnapshot[]> } | { ok: false };

/** Every review row of these books, grouped by book. Fails closed. */
export async function readReviewSnapshots(service: ServiceClient, bookIds: readonly string[]): Promise<ReviewSnapshotRead> {
  const byBook = new Map<string, ReviewSnapshot[]>();
  const ids = Array.from(new Set(bookIds));
  if (ids.length === 0) return { ok: true, byBook };
  const { data, error } = await service
    .from("book_reviews")
    .select(REVIEW_SNAPSHOT_COLUMNS)
    .in("book_id", ids)
    .returns<ReviewSnapshot[]>();
  if (error || !Array.isArray(data)) {
    console.error("readReviewSnapshots: read failed", { bookCount: ids.length, code: error?.code ?? null });
    return { ok: false };
  }
  for (const row of data) {
    const list = byBook.get(row.book_id) ?? [];
    list.push(row);
    byBook.set(row.book_id, list);
  }
  return { ok: true, byBook };
}

function time(iso: string | null): number {
  return iso === null ? -Infinity : Date.parse(iso);
}

/** The latest approved review (grandfathered included), by decision time. */
export function latestApprovedReview(reviews: readonly ReviewSnapshot[]): ReviewSnapshot | null {
  let best: ReviewSnapshot | null = null;
  for (const review of reviews) {
    if (review.status !== "approved") continue;
    if (
      best === null ||
      time(review.decided_at) > time(best.decided_at) ||
      (time(review.decided_at) === time(best.decided_at) && time(review.submitted_at) > time(best.submitted_at))
    ) {
      best = review;
    }
  }
  return best;
}

export function pendingReview(reviews: readonly ReviewSnapshot[]): ReviewSnapshot | null {
  return reviews.find((review) => review.status === "pending") ?? null;
}

// ------------------------------------------------------------
// N2 ★a: which file a reader downloads
// ------------------------------------------------------------
//
// The author always gets the current file. A buyer gets the file of the
// LATEST APPROVED review whenever the book has one (whatever its status
// or any pending / sent back / withdrawn / cancelled review), so a new
// file waiting for review never reaches buyers before Librum approves
// it; a book with no approval at all (a legacy draft never published)
// keeps today's behaviour, the current file.
export function resolveDownloadFilePath(params: {
  isAuthor: boolean;
  currentFilePath: string | null;
  reviews: readonly ReviewSnapshot[];
}): string | null {
  if (params.isAuthor) return params.currentFilePath;
  const approved = latestApprovedReview(params.reviews);
  return approved ? approved.file_path : params.currentFilePath;
}

export type DownloadFilePathRead = { ok: true; filePath: string | null } | { ok: false };

// P3: fails CLOSED -- on any read error a buyer gets "That file isn't
// available", never the current file as a fallback.
export async function readDownloadFilePath(
  service: ServiceClient,
  params: { bookId: string; isAuthor: boolean; currentFilePath: string | null },
): Promise<DownloadFilePathRead> {
  if (params.isAuthor) return { ok: true, filePath: params.currentFilePath };
  const read = await readReviewSnapshots(service, [params.bookId]);
  if (!read.ok) return { ok: false };
  return {
    ok: true,
    filePath: resolveDownloadFilePath({
      isAuthor: false,
      currentFilePath: params.currentFilePath,
      reviews: read.byBook.get(params.bookId) ?? [],
    }),
  };
}

// ------------------------------------------------------------
// N3 / P1: which manuscript keys of a book may be removed
// ------------------------------------------------------------
//
// KEEP the book's current file_path, its latest approved review's
// file_path, its pending review's file_path and (BD15 P5b-2) the
// manuscript of a live book's waiting changes (book_pending_changes,
// sent or not). Every other key of this
// book's own (own-key classifier: canonical or versioned, for exactly
// this author and book) among the key the caller just superseded and
// every review snapshot may be removed. Race-free because keys only move
// forward -- each write gets a fresh key -- so a key outside the keep
// set is never referenced again.
export function planManuscriptRemovals(params: {
  authorId: string;
  bookId: string;
  currentFilePath: string | null;
  reviews: readonly ReviewSnapshot[];
  superseded?: readonly (string | null)[];
  pendingChangeFilePath?: string | null;
}): string[] {
  const keep = new Set<string>();
  if (params.currentFilePath) keep.add(params.currentFilePath);
  if (params.pendingChangeFilePath) keep.add(params.pendingChangeFilePath);
  const approved = latestApprovedReview(params.reviews);
  if (approved?.file_path) keep.add(approved.file_path);
  const pending = pendingReview(params.reviews);
  if (pending?.file_path) keep.add(pending.file_path);

  const candidates = [...(params.superseded ?? []), ...params.reviews.map((review) => review.file_path)];
  const removals: string[] = [];
  for (const candidate of candidates) {
    if (
      isOwnBookManuscriptPath(candidate, params.authorId, params.bookId) &&
      !keep.has(candidate) &&
      !removals.includes(candidate)
    ) {
      removals.push(candidate);
    }
  }
  return removals;
}

// Every manuscript key a deleted book may leave behind: its current
// file_path and every review snapshot, own-key classified (N3, P5).
export function deletedBookManuscriptKeys(params: {
  authorId: string;
  bookId: string;
  currentFilePath: string | null;
  reviews: readonly ReviewSnapshot[];
}): string[] {
  const keys: string[] = [];
  for (const candidate of [params.currentFilePath, ...params.reviews.map((review) => review.file_path)]) {
    if (isOwnBookManuscriptPath(candidate, params.authorId, params.bookId) && !keys.includes(candidate)) {
      keys.push(candidate);
    }
  }
  return keys;
}

type StorageRemover = { storage: ServiceClient["storage"] };

// The retention cleanup after a proven write (updateBook), an approval
// or a send back / withdraw: reads the book's CURRENT file_path and its
// review snapshots with the trusted client (filtered by id AND
// author_id), then removes what the rule does not keep with `remover`.
// Best effort: a failure is an orphaned object, never a failed action,
// and is logged without any key.
export async function removeUnretainedManuscripts(
  service: ServiceClient,
  remover: StorageRemover,
  params: { authorId: string; bookId: string; superseded?: readonly (string | null)[]; caller: string },
): Promise<void> {
  try {
    const { data: book, error } = await service
      .from("books")
      .select("file_path")
      .eq("id", params.bookId)
      .eq("author_id", params.authorId)
      .maybeSingle<{ file_path: string | null }>();
    if (error || !book) {
      console.error(`${params.caller}: retention read failed; nothing removed`, { bookId: params.bookId });
      return;
    }
    const read = await readReviewSnapshots(service, [params.bookId]);
    if (!read.ok) {
      console.error(`${params.caller}: retention read failed; nothing removed`, { bookId: params.bookId });
      return;
    }
    // BD15 P5b-2: a live book's waiting manuscript is kept too, also
    // after a send back (its review snapshot is then no longer pending).
    // An unreadable row removes nothing.
    const { data: pending, error: pendingError } = await service
      .from("book_pending_changes")
      .select("file_path")
      .eq("book_id", params.bookId)
      .maybeSingle<{ file_path: string | null }>();
    if (pendingError) {
      console.error(`${params.caller}: retention read failed; nothing removed`, { bookId: params.bookId });
      return;
    }
    const removals = planManuscriptRemovals({
      authorId: params.authorId,
      bookId: params.bookId,
      currentFilePath: book.file_path,
      reviews: read.byBook.get(params.bookId) ?? [],
      superseded: params.superseded,
      pendingChangeFilePath: pending?.file_path ?? null,
    });
    if (removals.length === 0) return;
    const { error: removeError } = await remover.storage.from(BOOK_MANUSCRIPTS_BUCKET).remove(removals);
    if (removeError) {
      console.error(`${params.caller}: failed to remove superseded manuscripts`, { objectCount: removals.length });
    }
  } catch {
    console.error(`${params.caller}: manuscript retention cleanup failed`, { bookId: params.bookId });
  }
}
