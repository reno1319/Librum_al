import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { BOOK_FIXTURE_AUTHOR_ID as AUTHOR, BOOK_FIXTURE_BOOK_ID as BOOK, BOOK_FIXTURE_OTHER_AUTHOR_ID as OTHER_AUTHOR, BOOK_FIXTURE_OTHER_BOOK_ID as OTHER_BOOK } from "./book-storage-path-test-fixtures";
import {
  REVIEW_SNAPSHOT_COLUMNS,
  deletedBookManuscriptKeys,
  getBookReviewState,
  latestApprovedReview,
  loadAuthorReviewNotices,
  pendingReview,
  planManuscriptRemovals,
  readDownloadFilePath,
  readReviewSnapshots,
  removeUnretainedManuscripts,
  requestBookReview,
  resolveDownloadFilePath,
  withdrawBookReview,
  type ReviewSnapshot,
} from "./book-reviews";
import { AUTHOR_REVIEW_COLUMNS } from "./book-review-copy";

// ADMIN-3-REVIEW: the shared book_reviews reads and writes. The pure
// rules (N2 ★a: which file a buyer gets; N3/P1: which manuscript keys a
// book keeps) are pinned case by case; the I/O helpers against small
// recording doubles, including that every read error fails CLOSED.

const CANONICAL = `${AUTHOR}/${BOOK}.epub`;
const V1 = `${AUTHOR}/${BOOK}/0f0e0d0c-0b0a-4908-8706-050403020100.epub`;
const V2 = `${AUTHOR}/${BOOK}/1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d.epub`;
const V3 = `${AUTHOR}/${BOOK}/2b3c4d5e-6f70-4a1b-8c2d-3e4f5a6b7c8d.epub`;

let seq = 0;
function snap(status: ReviewSnapshot["status"], filePath: string | null, decidedAt: string | null, submittedAt = "2026-10-01T00:00:00Z"): ReviewSnapshot {
  seq += 1;
  return { id: `r${seq}`, book_id: BOOK, status, file_path: filePath, cover_path: null, submitted_at: submittedAt, decided_at: decidedAt };
}

// ------------------------------------------------------------
describe("latestApprovedReview / pendingReview", () => {
  it("picks the approval decided last, grandfathered ones included", () => {
    const older = snap("approved", CANONICAL, "2026-10-02T00:00:00Z");
    const newer = snap("approved", V1, "2026-10-05T00:00:00Z");
    expect(latestApprovedReview([newer, older])).toBe(newer);
    expect(latestApprovedReview([older, newer])).toBe(newer);
  });

  it("ties on decision time go to the later submission", () => {
    const a = snap("approved", V1, "2026-10-05T00:00:00Z", "2026-10-01T00:00:00Z");
    const b = snap("approved", V2, "2026-10-05T00:00:00Z", "2026-10-03T00:00:00Z");
    expect(latestApprovedReview([a, b])).toBe(b);
  });

  it("ignores every other status", () => {
    expect(
      latestApprovedReview([
        snap("pending", V1, null),
        snap("sent_back", V2, "2026-10-09T00:00:00Z"),
        snap("withdrawn", V3, "2026-10-09T00:00:00Z"),
        snap("cancelled", CANONICAL, "2026-10-09T00:00:00Z"),
      ]),
    ).toBeNull();
    const pending = snap("pending", V1, null);
    expect(pendingReview([snap("approved", V2, "2026-10-01T00:00:00Z"), pending])).toBe(pending);
    expect(pendingReview([])).toBeNull();
  });
});

// ------------------------------------------------------------
describe("resolveDownloadFilePath (N2 ★a)", () => {
  const approvedOld = snap("approved", V1, "2026-10-02T00:00:00Z");

  it("the author always gets the current file", () => {
    expect(resolveDownloadFilePath({ isAuthor: true, currentFilePath: V2, reviews: [approvedOld] })).toBe(V2);
  });

  it("a buyer gets the latest approved file while a newer one is pending", () => {
    expect(
      resolveDownloadFilePath({ isAuthor: false, currentFilePath: V2, reviews: [approvedOld, snap("pending", V2, null)] }),
    ).toBe(V1);
  });

  it("... and after it was sent back, withdrawn or cancelled", () => {
    for (const status of ["sent_back", "withdrawn", "cancelled"] as const) {
      expect(
        resolveDownloadFilePath({
          isAuthor: false,
          currentFilePath: V2,
          reviews: [approvedOld, snap(status, V2, "2026-10-04T00:00:00Z")],
        }),
      ).toBe(V1);
    }
  });

  it("a newer approval wins", () => {
    expect(
      resolveDownloadFilePath({
        isAuthor: false,
        currentFilePath: V2,
        reviews: [approvedOld, snap("approved", V2, "2026-10-06T00:00:00Z")],
      }),
    ).toBe(V2);
  });

  it("a book never approved gives a buyer the current file (legacy behaviour)", () => {
    expect(resolveDownloadFilePath({ isAuthor: false, currentFilePath: CANONICAL, reviews: [] })).toBe(CANONICAL);
    expect(
      resolveDownloadFilePath({ isAuthor: false, currentFilePath: V2, reviews: [snap("sent_back", V2, "2026-10-04T00:00:00Z")] }),
    ).toBe(V2);
  });
});

// ------------------------------------------------------------
describe("planManuscriptRemovals (N3 / P1)", () => {
  it("keeps the current file, the latest approved file and the pending file", () => {
    const reviews = [
      snap("approved", CANONICAL, "2026-10-02T00:00:00Z"),
      snap("approved", V1, "2026-10-05T00:00:00Z"),
      snap("pending", V3, null),
    ];
    expect(planManuscriptRemovals({ authorId: AUTHOR, bookId: BOOK, currentFilePath: V3, reviews, superseded: [V2] })).toEqual([
      V2,
      CANONICAL,
    ]);
  });

  it("removes a superseded key the history does not keep, once", () => {
    expect(
      planManuscriptRemovals({
        authorId: AUTHOR,
        bookId: BOOK,
        currentFilePath: V2,
        reviews: [snap("cancelled", V1, "2026-10-03T00:00:00Z"), snap("sent_back", V1, "2026-10-04T00:00:00Z")],
        superseded: [V1, V1, null],
      }),
    ).toEqual([V1]);
  });

  it("never removes the key a buyer is still served", () => {
    const removals = planManuscriptRemovals({
      authorId: AUTHOR,
      bookId: BOOK,
      currentFilePath: V2,
      reviews: [snap("approved", V1, "2026-10-02T00:00:00Z"), snap("pending", V2, null)],
      superseded: [V1],
    });
    expect(removals).toEqual([]);
  });

  it("classifies every candidate against this author and book only", () => {
    const foreign = [
      `${OTHER_AUTHOR}/${BOOK}.epub`,
      `${AUTHOR}/${OTHER_BOOK}.epub`,
      `${AUTHOR}/${OTHER_BOOK}/0f0e0d0c-0b0a-4908-8706-050403020100.epub`,
      `${AUTHOR}/tmp/epub/0f0e0d0c-0b0a-4908-8706-050403020100.epub`,
      `${AUTHOR}/${BOOK}/../x.epub`,
      "",
    ];
    expect(
      planManuscriptRemovals({
        authorId: AUTHOR,
        bookId: BOOK,
        currentFilePath: V2,
        reviews: foreign.map((path) => snap("cancelled", path, "2026-10-03T00:00:00Z")),
        superseded: foreign,
      }),
    ).toEqual([]);
  });
});

describe("deletedBookManuscriptKeys (N3 / P5)", () => {
  it("the current file and every own snapshot key, de-duplicated", () => {
    expect(
      deletedBookManuscriptKeys({
        authorId: AUTHOR,
        bookId: BOOK,
        currentFilePath: V2,
        reviews: [snap("approved", CANONICAL, "2026-10-01T00:00:00Z"), snap("pending", V2, null), snap("cancelled", V1, "2026-10-02T00:00:00Z")],
      }),
    ).toEqual([V2, CANONICAL, V1]);
  });

  it("skips anything that is not this author's own key for this book", () => {
    expect(
      deletedBookManuscriptKeys({
        authorId: AUTHOR,
        bookId: BOOK,
        currentFilePath: `${OTHER_AUTHOR}/${BOOK}.epub`,
        reviews: [snap("approved", `${AUTHOR}/${OTHER_BOOK}.epub`, "2026-10-01T00:00:00Z"), snap("cancelled", null, null)],
      }),
    ).toEqual([]);
  });
});

// ------------------------------------------------------------
// A1 = a (Q1 / R1 / U2): the migration's buyer_file_only rows
// ------------------------------------------------------------
// The backfill records the current file of a draft readers may already
// hold as an approved, grandfathered, buyer_file_only review. Only the
// publish gate (book_review_approval_valid, in SQL) ignores it; every rule
// here counts it like any other approval, or the readers' file would be
// lost.
describe("buyer_file_only rows (A1, R1)", () => {
  function buyerFileOnly(filePath: string): ReviewSnapshot {
    return { ...snap("approved", filePath, "2026-10-20T12:00:00Z"), buyer_file_only: true } as ReviewSnapshot;
  }

  it("is the latest approval for the buyer rule", () => {
    const row = buyerFileOnly(V1);
    expect(latestApprovedReview([row, snap("pending", V2, null)])).toBe(row);
  });

  it("a buyer gets the buyer_file_only snapshot after the author uploads a new file; the author gets the new one", () => {
    const reviews = [buyerFileOnly(V1), snap("pending", V2, null, "2026-10-21T00:00:00Z")];
    expect(resolveDownloadFilePath({ isAuthor: false, currentFilePath: V2, reviews })).toBe(V1);
    expect(resolveDownloadFilePath({ isAuthor: true, currentFilePath: V2, reviews })).toBe(V2);
    // ... and still after a send back.
    expect(
      resolveDownloadFilePath({ isAuthor: false, currentFilePath: V2, reviews: [buyerFileOnly(V1), snap("sent_back", V2, "2026-10-22T00:00:00Z")] }),
    ).toBe(V1);
  });

  it("retention keeps the buyer_file_only file while a newer file is pending", () => {
    expect(
      planManuscriptRemovals({
        authorId: AUTHOR,
        bookId: BOOK,
        currentFilePath: V3,
        reviews: [buyerFileOnly(V1), snap("cancelled", V2, "2026-10-21T00:00:00Z"), snap("pending", V3, null)],
        superseded: [V2],
      }),
    ).toEqual([V2]);
  });

  it("deleting the book removes it with the book's other keys", () => {
    expect(deletedBookManuscriptKeys({ authorId: AUTHOR, bookId: BOOK, currentFilePath: V2, reviews: [buyerFileOnly(V1)] })).toEqual([V2, V1]);
  });

  it("no app read or rule filters on buyer_file_only (U2)", () => {
    const root = path.join(__dirname, "..");
    for (const file of ["lib/book-reviews.ts", "app/api/books/[id]/download/route.ts"]) {
      expect(readFileSync(path.join(root, file), "utf8")).not.toMatch(/buyer_file_only/);
    }
  });
});

// ------------------------------------------------------------
// I/O helpers
// ------------------------------------------------------------

function rpcClient(result: { data?: unknown; error?: unknown }) {
  const rpc = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }));
  return { client: { rpc } as never, rpc };
}

describe("getBookReviewState", () => {
  it("maps book_review_state()", async () => {
    const { client, rpc } = rpcClient({
      data: {
        pending: false,
        approval_valid: true,
        latest_sent_back: { reason: "broken_file", message: "Fix it", decided_at: "2026-10-04T00:00:00Z" },
      },
    });
    expect(await getBookReviewState(client, BOOK)).toEqual({
      kind: "ok",
      pending: false,
      approvalValid: true,
      latestSentBack: { reason: "broken_file", message: "Fix it", sentBackAt: "2026-10-04T00:00:00Z" },
    });
    expect(rpc).toHaveBeenCalledWith("book_review_state", { p_book_id: BOOK });
  });

  it("an error or a malformed answer is unavailable, never 'approved'", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const result of [
      { error: { code: "42883", message: "no function" } },
      { data: null },
      { data: { pending: "no", approval_valid: true } },
      { data: { pending: false } },
    ]) {
      expect(await getBookReviewState(rpcClient(result).client, BOOK)).toEqual({ kind: "unavailable" });
    }
    vi.restoreAllMocks();
  });
});

describe("requestBookReview / withdrawBookReview", () => {
  it.each([
    ["this book is already waiting for review", "already_pending"],
    ["this book is already approved", "already_approved"],
    ["this book is already published", "already_published"],
    ["no book found for this id", "not_found"],
  ])("maps %j", async (message, reason) => {
    expect(await requestBookReview(rpcClient({ error: { code: "P0001", message } }).client, BOOK)).toEqual({ ok: false, reason });
  });

  it("LB460 is a takedown; anything else is a plain failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await requestBookReview(rpcClient({ error: { code: "LB460", message: "x" } }).client, BOOK)).toEqual({ ok: false, reason: "taken_down" });
    expect(await requestBookReview(rpcClient({ error: { code: "XX000", message: "x" } }).client, BOOK)).toEqual({ ok: false, reason: "failed" });
    vi.restoreAllMocks();
  });

  it("calls the RPCs with the book id only", async () => {
    const request = rpcClient({});
    expect(await requestBookReview(request.client, BOOK)).toEqual({ ok: true });
    expect(request.rpc).toHaveBeenCalledWith("request_book_review", { p_book_id: BOOK });
    const withdraw = rpcClient({});
    expect(await withdrawBookReview(withdraw.client, BOOK)).toEqual({ ok: true });
    expect(withdraw.rpc).toHaveBeenCalledWith("withdraw_book_review", { p_book_id: BOOK });
  });

  it("withdraw maps 'not waiting' and fails otherwise", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await withdrawBookReview(rpcClient({ error: { message: "this book is not waiting for review" } }).client, BOOK)).toEqual({
      ok: false,
      reason: "not_pending",
    });
    expect(await withdrawBookReview(rpcClient({ error: { message: "boom" } }).client, BOOK)).toEqual({ ok: false, reason: "failed" });
    vi.restoreAllMocks();
  });
});

type Recorded = { table: string; columns?: string; filters: [string, string, unknown][] };

function tableClient(results: Record<string, { data: unknown; error: unknown }>) {
  const recorded: Recorded[] = [];
  const removed: { bucket: string; paths: string[] }[] = [];
  const client = {
    from: (table: string) => {
      const call: Recorded = { table, filters: [] };
      recorded.push(call);
      const result = results[table] ?? { data: null, error: { message: `unexpected ${table}` } };
      const chain: Record<string, unknown> = {
        select: (columns: string) => ((call.columns = columns), chain),
        eq: (column: string, value: unknown) => (call.filters.push(["eq", column, value]), chain),
        in: (column: string, value: unknown) => (call.filters.push(["in", column, value]), chain),
        not: (column: string, op: string, value: unknown) => (call.filters.push(["not", `${column} ${op}`, value]), chain),
        returns: () => chain,
        maybeSingle: async () => result,
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(result).then(f, r),
      };
      return chain;
    },
    storage: {
      from: (bucket: string) => ({
        remove: async (paths: string[]) => {
          removed.push({ bucket, paths });
          return { data: [], error: null };
        },
      }),
    },
  };
  return { client: client as never, recorded, removed };
}

describe("loadAuthorReviewNotices (N9)", () => {
  it("one read of the author's own rows, granted columns only", async () => {
    const { client, recorded } = tableClient({
      book_reviews: {
        data: [
          { book_id: BOOK, book_title: "T", author_id: AUTHOR, status: "pending", submitted_at: "2026-10-05T00:00:00Z", reason: null, message_to_author: null, decided_at: null },
        ],
        error: null,
      },
    });
    const notices = await loadAuthorReviewNotices(client, AUTHOR);
    expect(notices.get(BOOK)).toEqual({ inReview: true, sentBack: null });
    expect(recorded).toEqual([
      { table: "book_reviews", columns: AUTHOR_REVIEW_COLUMNS, filters: [["eq", "author_id", AUTHOR], ["not", "book_id is", null]] },
    ]);
  });

  it("a failed read shows nothing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = tableClient({ book_reviews: { data: null, error: { code: "42501" } } });
    expect((await loadAuthorReviewNotices(client, AUTHOR)).size).toBe(0);
    vi.restoreAllMocks();
  });
});

describe("readReviewSnapshots / readDownloadFilePath (P3: fail closed)", () => {
  it("reads the snapshot columns for the given books, grouped by book", async () => {
    const rows = [snap("approved", V1, "2026-10-02T00:00:00Z"), { ...snap("pending", V2, null), book_id: OTHER_BOOK }];
    const { client, recorded } = tableClient({ book_reviews: { data: rows, error: null } });
    const read = await readReviewSnapshots(client, [BOOK, OTHER_BOOK, BOOK]);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.byBook.get(BOOK)).toEqual([rows[0]]);
      expect(read.byBook.get(OTHER_BOOK)).toEqual([rows[1]]);
    }
    expect(recorded).toEqual([{ table: "book_reviews", columns: REVIEW_SNAPSHOT_COLUMNS, filters: [["in", "book_id", [BOOK, OTHER_BOOK]]] }]);
  });

  it("no books: no read", async () => {
    const { client, recorded } = tableClient({});
    expect(await readReviewSnapshots(client, [])).toEqual({ ok: true, byBook: new Map() });
    expect(recorded).toEqual([]);
  });

  it("an error or a non-list result fails closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const result of [{ data: null, error: { code: "42501" } }, { data: { not: "a list" }, error: null }, { data: [], error: { code: "57014" } }]) {
      expect(await readReviewSnapshots(tableClient({ book_reviews: result }).client, [BOOK])).toEqual({ ok: false });
      expect(
        await readDownloadFilePath(tableClient({ book_reviews: result }).client, { bookId: BOOK, isAuthor: false, currentFilePath: V2 }),
      ).toEqual({ ok: false });
    }
    vi.restoreAllMocks();
  });

  it("the author's download needs no read", async () => {
    const { client, recorded } = tableClient({});
    expect(await readDownloadFilePath(client, { bookId: BOOK, isAuthor: true, currentFilePath: V2 })).toEqual({ ok: true, filePath: V2 });
    expect(recorded).toEqual([]);
  });

  it("a buyer's download resolves through the approved snapshot", async () => {
    const { client } = tableClient({ book_reviews: { data: [snap("approved", V1, "2026-10-02T00:00:00Z"), snap("pending", V2, null)], error: null } });
    expect(await readDownloadFilePath(client, { bookId: BOOK, isAuthor: false, currentFilePath: V2 })).toEqual({ ok: true, filePath: V1 });
  });
});

describe("removeUnretainedManuscripts", () => {
  it("re-reads the current file (id AND author_id), then removes only what is not kept, with the remover", async () => {
    const service = tableClient({
      books: { data: { file_path: V3 }, error: null },
      book_reviews: { data: [snap("approved", V1, "2026-10-02T00:00:00Z"), snap("cancelled", V2, "2026-10-03T00:00:00Z")], error: null },
    });
    const remover = tableClient({});
    await removeUnretainedManuscripts(service.client, remover.client, { authorId: AUTHOR, bookId: BOOK, superseded: [CANONICAL], caller: "test" });
    expect(service.recorded[0]).toEqual({ table: "books", columns: "file_path", filters: [["eq", "id", BOOK], ["eq", "author_id", AUTHOR]] });
    expect(service.removed).toEqual([]);
    expect(remover.removed).toEqual([{ bucket: "manuscripts", paths: [CANONICAL, V2] }]);
  });

  it("removes nothing when either read fails or finds no row", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cases: Record<string, { data: unknown; error: unknown }>[] = [
      { books: { data: null, error: { code: "57014" } } },
      { books: { data: null, error: null } },
      { books: { data: { file_path: V3 }, error: null }, book_reviews: { data: null, error: { code: "42501" } } },
    ];
    for (const results of cases) {
      const remover = tableClient({});
      await removeUnretainedManuscripts(tableClient(results).client, remover.client, { authorId: AUTHOR, bookId: BOOK, superseded: [V1], caller: "test" });
      expect(remover.removed).toEqual([]);
    }
    vi.restoreAllMocks();
  });

  it("never throws, and logs no key", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const service = { from: () => { throw new Error(`boom ${V1}`); } } as never;
    await expect(removeUnretainedManuscripts(service, tableClient({}).client, { authorId: AUTHOR, bookId: BOOK, superseded: [V1], caller: "test" })).resolves.toBeUndefined();
    expect(JSON.stringify(errors.mock.calls)).not.toContain(V1);
    vi.restoreAllMocks();
  });
});
