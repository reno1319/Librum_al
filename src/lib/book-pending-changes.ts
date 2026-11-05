import "server-only";
import type { createCatalogWriteClient } from "@/lib/catalog-write-client";

// BD15 P5b-2: a live book's changes that wait for Librum's review
// (migration 20261104170000, table book_pending_changes). The book row
// stays the live version; the waiting manuscript, ballinë, description,
// 18+ label and original author live here until Librum approves them
// (admin_approve_book_review copies them onto the book) or the author
// discards them. Renato 11-04: Q1 a (split), Q2 a (sent changes make the
// whole book read-only), Q3 a (taken offline: they become the draft).
//
// The table is readable by service_role only and written only through
// save_book_pending_changes / discard_book_pending_changes, which lock
// the book first. Every caller passes the trusted catalog writer and the
// session's VERIFIED user id (audit P5b-1 r2, R2-3), after its own
// ownership read; the functions answer another account's book as missing.

type CatalogWriter = ReturnType<typeof createCatalogWriteClient>;

export type PendingChanges = {
  filePath: string | null;
  coverPath: string | null;
  description: string;
  isAdult: boolean;
  originalAuthor: string | null;
};

/** The five values a live book shows now (its own row). */
export type LiveReviewValues = PendingChanges;

export const PENDING_CHANGE_FIELDS = ["filePath", "coverPath", "description", "isAdult", "originalAuthor"] as const;
export type PendingChangeField = (typeof PENDING_CHANGE_FIELDS)[number];

type PendingRow = {
  book_id: string;
  file_path: string | null;
  cover_path: string | null;
  description: string;
  is_adult: boolean;
  original_author: string | null;
  created_at: string;
  version: number;
};

// BD15 P5b-3a: when the waiting changes were first saved. A sent-back
// note belongs to the changes it was about: after "Hidhni ndryshimet"
// and a new change, the old note no longer shows (editor page).
// BD15 P5b-3b (migration 20261105120000, audit P5b-2 r1 F4): the row's
// version, null when there is none. A save or discard passes the version
// it read; the database refuses it (LB496) when another write came in
// between (Renato 11-05, Q1 a: the later save is refused, never merged).
export type PendingChangesRead =
  | { ok: true; pending: PendingChanges | null; createdAt: string | null; version: number | null }
  | { ok: false };

/** The book's waiting changes, or null. The caller proved ownership. */
export async function readPendingChanges(service: CatalogWriter, bookId: string): Promise<PendingChangesRead> {
  try {
    const { data, error } = await service
      .from("book_pending_changes")
      .select("book_id, file_path, cover_path, description, is_adult, original_author, created_at, version")
      .eq("book_id", bookId)
      .maybeSingle<PendingRow>();
    if (error) {
      console.error("readPendingChanges: read failed", { bookId, code: error.code ?? null });
      return { ok: false };
    }
    if (!data) return { ok: true, pending: null, createdAt: null, version: null };
    if (data.book_id !== bookId) return { ok: false };
    if (!Number.isSafeInteger(data.version) || data.version < 1) return { ok: false };
    return {
      ok: true,
      pending: {
        filePath: data.file_path,
        coverPath: data.cover_path,
        description: data.description,
        isAdult: data.is_adult,
        originalAuthor: data.original_author,
      },
      createdAt: data.created_at,
      version: data.version,
    };
  } catch {
    console.error("readPendingChanges: read failed", { bookId });
    return { ok: false };
  }
}

// BD15 P5b-3b (Renato 11-05, Q2 a): deleting an account removes the
// files its live books' waiting changes name and nothing else does (a
// change never sent for review is in no review snapshot). Read before the
// account is deleted: the rows go with their books. The caller classifies
// every value against its own account and book.
export type PendingFilesRead = { ok: true; byBook: Map<string, PendingChanges> } | { ok: false };

/** The waiting changes of these books (the caller proved they are its own). */
export async function readPendingChangesForBooks(service: CatalogWriter, bookIds: readonly string[]): Promise<PendingFilesRead> {
  const byBook = new Map<string, PendingChanges>();
  const ids = Array.from(new Set(bookIds));
  if (ids.length === 0) return { ok: true, byBook };
  try {
    const { data, error } = await service
      .from("book_pending_changes")
      .select("book_id, file_path, cover_path, description, is_adult, original_author")
      .in("book_id", ids)
      .returns<Omit<PendingRow, "created_at" | "version">[]>();
    if (error || !Array.isArray(data)) {
      console.error("readPendingChangesForBooks: read failed", { bookCount: ids.length, code: error?.code ?? null });
      return { ok: false };
    }
    for (const row of data) {
      if (!ids.includes(row.book_id)) return { ok: false };
      byBook.set(row.book_id, {
        filePath: row.file_path,
        coverPath: row.cover_path,
        description: row.description,
        isAdult: row.is_adult,
        originalAuthor: row.original_author,
      });
    }
    return { ok: true, byBook };
  } catch {
    console.error("readPendingChangesForBooks: read failed", { bookCount: ids.length });
    return { ok: false };
  }
}

/** Which of the five differ between the live book and its waiting changes. */
export function changedPendingFields(live: LiveReviewValues, pending: PendingChanges): PendingChangeField[] {
  return PENDING_CHANGE_FIELDS.filter((field) => (live[field] ?? null) !== (pending[field] ?? null));
}

export type SavePendingResult =
  | { ok: true }
  | {
      ok: false;
      reason: "in_review" | "not_live" | "adult_category" | "cover_taken" | "invalid" | "conflict" | "not_found" | "failed";
    };

// The database's own refusals (P5b-1), mapped for the editor (audit
// P5b-1 r2, R2-4): LB490 sent for review meanwhile, LB491 no longer live,
// LB493 18+ beside a children/teen category, LB495 or a duplicate cover
// key, 23514 a check (blank description, bad cover key), LB496 another
// write since this request read the row (P5b-3b).
function mapPendingError(error: { code?: string | null; message?: string | null }): SavePendingResult {
  switch (error.code) {
    case "LB490":
      return { ok: false, reason: "in_review" };
    case "LB491":
      return { ok: false, reason: "not_live" };
    case "LB493":
      return { ok: false, reason: "adult_category" };
    case "LB495":
    case "23505":
      return { ok: false, reason: "cover_taken" };
    case "23514":
      return { ok: false, reason: "invalid" };
    case "LB496":
      return { ok: false, reason: "conflict" };
    default:
      if (error.message === "no book found for this id") return { ok: false, reason: "not_found" };
      return { ok: false, reason: "failed" };
  }
}

/**
 * Saves the whole waiting version (all five values) of a live book.
 * expectedVersion: the version this request read (null: it read none).
 */
export async function savePendingChanges(
  service: CatalogWriter,
  params: { authorId: string; bookId: string; expectedVersion: number | null; changes: PendingChanges },
): Promise<SavePendingResult> {
  try {
    const { error } = await service.rpc("save_book_pending_changes", {
      p_author_id: params.authorId,
      p_book_id: params.bookId,
      p_expected_version: params.expectedVersion,
      p_file_path: params.changes.filePath,
      p_cover_path: params.changes.coverPath,
      p_description: params.changes.description,
      p_is_adult: params.changes.isAdult,
      p_original_author: params.changes.originalAuthor,
    });
    if (!error) return { ok: true };
    const mapped = mapPendingError(error);
    if (!mapped.ok && mapped.reason === "failed") {
      console.error("savePendingChanges: save failed", { bookId: params.bookId, code: error.code ?? null });
    }
    return mapped;
  } catch {
    console.error("savePendingChanges: save failed", { bookId: params.bookId });
    return { ok: false, reason: "failed" };
  }
}

export type DiscardPendingResult =
  | { ok: true; discarded: boolean }
  | { ok: false; reason: "in_review" | "conflict" | "not_found" | "failed" };

/** "Hidhni ndryshimet": true when there was something to discard. */
export async function discardPendingChanges(
  service: CatalogWriter,
  params: { authorId: string; bookId: string; expectedVersion: number | null },
): Promise<DiscardPendingResult> {
  try {
    const { data, error } = await service.rpc("discard_book_pending_changes", {
      p_author_id: params.authorId,
      p_book_id: params.bookId,
      p_expected_version: params.expectedVersion,
    });
    if (!error) return { ok: true, discarded: data === true };
    if (error.code === "LB490") return { ok: false, reason: "in_review" };
    if (error.code === "LB496") return { ok: false, reason: "conflict" };
    if (error.message === "no book found for this id") return { ok: false, reason: "not_found" };
    console.error("discardPendingChanges: discard failed", { bookId: params.bookId, code: error.code ?? null });
    return { ok: false, reason: "failed" };
  } catch {
    console.error("discardPendingChanges: discard failed", { bookId: params.bookId });
    return { ok: false, reason: "failed" };
  }
}
