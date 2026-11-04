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
};

export type PendingChangesRead = { ok: true; pending: PendingChanges | null } | { ok: false };

/** The book's waiting changes, or null. The caller proved ownership. */
export async function readPendingChanges(service: CatalogWriter, bookId: string): Promise<PendingChangesRead> {
  try {
    const { data, error } = await service
      .from("book_pending_changes")
      .select("book_id, file_path, cover_path, description, is_adult, original_author")
      .eq("book_id", bookId)
      .maybeSingle<PendingRow>();
    if (error) {
      console.error("readPendingChanges: read failed", { bookId, code: error.code ?? null });
      return { ok: false };
    }
    if (!data) return { ok: true, pending: null };
    if (data.book_id !== bookId) return { ok: false };
    return {
      ok: true,
      pending: {
        filePath: data.file_path,
        coverPath: data.cover_path,
        description: data.description,
        isAdult: data.is_adult,
        originalAuthor: data.original_author,
      },
    };
  } catch {
    console.error("readPendingChanges: read failed", { bookId });
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
      reason: "in_review" | "not_live" | "adult_category" | "cover_taken" | "invalid" | "not_found" | "failed";
    };

// The database's own refusals (P5b-1), mapped for the editor (audit
// P5b-1 r2, R2-4): LB490 sent for review meanwhile, LB491 no longer live,
// LB493 18+ beside a children/teen category, LB495 or a duplicate cover
// key, 23514 a check (blank description, bad cover key).
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
    default:
      if (error.message === "no book found for this id") return { ok: false, reason: "not_found" };
      return { ok: false, reason: "failed" };
  }
}

/** Saves the whole waiting version (all five values) of a live book. */
export async function savePendingChanges(
  service: CatalogWriter,
  params: { authorId: string; bookId: string; changes: PendingChanges },
): Promise<SavePendingResult> {
  try {
    const { error } = await service.rpc("save_book_pending_changes", {
      p_author_id: params.authorId,
      p_book_id: params.bookId,
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
  | { ok: false; reason: "in_review" | "not_found" | "failed" };

/** "Hidhni ndryshimet": true when there was something to discard. */
export async function discardPendingChanges(
  service: CatalogWriter,
  params: { authorId: string; bookId: string },
): Promise<DiscardPendingResult> {
  try {
    const { data, error } = await service.rpc("discard_book_pending_changes", {
      p_author_id: params.authorId,
      p_book_id: params.bookId,
    });
    if (!error) return { ok: true, discarded: data === true };
    if (error.code === "LB490") return { ok: false, reason: "in_review" };
    if (error.message === "no book found for this id") return { ok: false, reason: "not_found" };
    console.error("discardPendingChanges: discard failed", { bookId: params.bookId, code: error.code ?? null });
    return { ok: false, reason: "failed" };
  } catch {
    console.error("discardPendingChanges: discard failed", { bookId: params.bookId });
    return { ok: false, reason: "failed" };
  }
}
