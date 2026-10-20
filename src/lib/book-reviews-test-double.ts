// TEST-ONLY. Never imported by application code.
//
// ADMIN-3-REVIEW: the action suites written before "In review" use
// session/catalog doubles that know nothing about book_reviews (no
// rpc(), no `.in()`). They mock "@/lib/book-reviews" with this double:
// the pure helpers stay real; the four reads/writes are replaced by a
// mutable state each suite can set. The default is the state of every
// book those suites were written for: no pending review, and an approval
// that still matches the current files (so Publish publishes, as before).
//
// The review rules themselves are pinned in src/lib/book-reviews.test.ts
// and the SQL suite (077); this double only keeps the older suites
// focused on what they test.
import { BOOK_MANUSCRIPTS_BUCKET, isOwnBookManuscriptPath } from "@/lib/book-storage-path";

export type BookReviewsDoubleState = {
  stateKind: "ok" | "unavailable";
  pending: boolean;
  approvalValid: boolean;
  latestSentBack: { reason: string; message: string; sentBackAt: string } | null;
  requestResult: { ok: true } | { ok: false; reason: string };
  withdrawResult: { ok: true } | { ok: false; reason: string };
  snapshotsOk: boolean;
  snapshots: { book_id: string; file_path: string | null; status: string }[];
  calls: { fn: string; bookId: string }[];
};

export function defaultBookReviewsDoubleState(): BookReviewsDoubleState {
  return {
    stateKind: "ok",
    pending: false,
    approvalValid: true,
    latestSentBack: null,
    requestResult: { ok: true },
    withdrawResult: { ok: true },
    snapshotsOk: true,
    snapshots: [],
    calls: [],
  };
}

export const bookReviewsDoubleState: BookReviewsDoubleState = defaultBookReviewsDoubleState();

export function resetBookReviewsDouble(): void {
  Object.assign(bookReviewsDoubleState, defaultBookReviewsDoubleState());
}

type Remover = { storage: { from(bucket: string): { remove(paths: string[]): unknown } } };

/** Spread over the real module inside vi.mock("@/lib/book-reviews"). */
export function bookReviewsDouble<T extends object>(actual: T) {
  const s = bookReviewsDoubleState;
  return {
    ...actual,
    getBookReviewState: async (_client: unknown, bookId: string) => {
      s.calls.push({ fn: "getBookReviewState", bookId });
      return s.stateKind === "unavailable"
        ? { kind: "unavailable" as const }
        : { kind: "ok" as const, pending: s.pending, approvalValid: s.approvalValid, latestSentBack: s.latestSentBack };
    },
    requestBookReview: async (_client: unknown, bookId: string) => {
      s.calls.push({ fn: "requestBookReview", bookId });
      return s.requestResult;
    },
    withdrawBookReview: async (_client: unknown, bookId: string) => {
      s.calls.push({ fn: "withdrawBookReview", bookId });
      return s.withdrawResult;
    },
    loadAuthorReviewNotices: async () => new Map(),
    readReviewSnapshots: async (_client: unknown, bookIds: readonly string[]) => {
      for (const bookId of bookIds) s.calls.push({ fn: "readReviewSnapshots", bookId });
      if (!s.snapshotsOk) return { ok: false as const };
      const byBook = new Map<string, unknown[]>();
      for (const row of s.snapshots) {
        if (!bookIds.includes(row.book_id)) continue;
        byBook.set(row.book_id, [...(byBook.get(row.book_id) ?? []), row]);
      }
      return { ok: true as const, byBook };
    },
    // No review snapshots: the key the write superseded is removed when
    // it is this book's own key (the new key is the current file).
    removeUnretainedManuscripts: async (
      _service: unknown,
      remover: Remover,
      params: { authorId: string; bookId: string; superseded?: readonly (string | null)[] },
    ) => {
      s.calls.push({ fn: "removeUnretainedManuscripts", bookId: params.bookId });
      const keys = (params.superseded ?? []).filter((key): key is string =>
        isOwnBookManuscriptPath(key, params.authorId, params.bookId),
      );
      if (keys.length > 0) await remover.storage.from(BOOK_MANUSCRIPTS_BUCKET).remove(keys);
    },
  };
}
