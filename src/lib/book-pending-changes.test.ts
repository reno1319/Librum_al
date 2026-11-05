import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { changedPendingFields, discardPendingChanges, readPendingChanges, readPendingChangesForBooks, savePendingChanges } = await import(
  "./book-pending-changes"
);

// BD15 P5b-2: the app side of book_pending_changes (P5b-1). The table's
// rules, locks and refusals are pinned in the SQL suite; this pins what
// the app sends and how each refusal reaches the editor.

const BOOK = "c3d4e5f6-2222-4222-8222-abcdef222222";
const AUTHOR = "a1b2c3d4-1111-4111-8111-abcdef111111";
const CHANGES = { filePath: "f.epub", coverPath: "c/cover.jpg", description: "D", isAdult: false, originalAuthor: null };

function readClient(result: { data: unknown; error: unknown } | "throw") {
  const filters: unknown[] = [];
  const chain = {
    select: (columns: string) => (filters.push(["select", columns]), chain),
    eq: (column: string, value: unknown) => (filters.push(["eq", column, value]), chain),
    maybeSingle: async () => {
      if (result === "throw") throw new Error("boom");
      return result;
    },
  };
  const client = { from: (table: string) => (filters.push(["from", table]), chain) };
  return { client: client as never, filters };
}

function rpcClient(result: { data: unknown; error: unknown } | "throw") {
  const calls: { fn: string; args: unknown }[] = [];
  const client = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      if (result === "throw") throw new Error("boom");
      return result;
    },
  };
  return { client: client as never, calls };
}

describe("readPendingChanges", () => {
  it("reads the one row by book id and maps it", async () => {
    const { client, filters } = readClient({
      data: {
        book_id: BOOK,
        file_path: "f.epub",
        cover_path: "c/cover.jpg",
        description: "D",
        is_adult: true,
        original_author: "Homeri",
        created_at: "2026-11-04T10:00:00Z",
        version: 3,
      },
      error: null,
    });
    expect(await readPendingChanges(client, BOOK)).toEqual({
      ok: true,
      pending: { filePath: "f.epub", coverPath: "c/cover.jpg", description: "D", isAdult: true, originalAuthor: "Homeri" },
      // BD15 P5b-3a: when the changes were first saved (stale send-back note).
      createdAt: "2026-11-04T10:00:00Z",
      // BD15 P5b-3b: the version a save or discard passes back.
      version: 3,
    });
    expect(filters).toContainEqual(["from", "book_pending_changes"]);
    expect(filters).toContainEqual(["eq", "book_id", BOOK]);
  });

  it("no row is no waiting changes", async () => {
    expect(await readPendingChanges(readClient({ data: null, error: null }).client, BOOK)).toEqual({
      ok: true,
      pending: null,
      createdAt: null,
      version: null,
    });
  });

  it.each([0, -1, 1.5, "2", null])("an unusable version (%o) is a failed read, never a blind save", async (version) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const row = {
      book_id: BOOK,
      file_path: "f.epub",
      cover_path: "c/cover.jpg",
      description: "D",
      is_adult: false,
      original_author: null,
      created_at: "2026-11-04T10:00:00Z",
      version,
    };
    expect(await readPendingChanges(readClient({ data: row, error: null }).client, BOOK)).toEqual({ ok: false });
    vi.restoreAllMocks();
  });

  it("an error, a throw or another book's row is a failed read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readPendingChanges(readClient({ data: null, error: { code: "42501" } }).client, BOOK)).toEqual({ ok: false });
    expect(await readPendingChanges(readClient("throw").client, BOOK)).toEqual({ ok: false });
    const other = { book_id: "other", file_path: null, cover_path: null, description: "D", is_adult: false, original_author: null };
    expect(await readPendingChanges(readClient({ data: other, error: null }).client, BOOK)).toEqual({ ok: false });
    vi.restoreAllMocks();
  });
});

describe("changedPendingFields", () => {
  it("names exactly the values that differ; null and undefined are the same", () => {
    expect(changedPendingFields(CHANGES, { ...CHANGES })).toEqual([]);
    expect(changedPendingFields(CHANGES, { ...CHANGES, coverPath: "n/cover.jpg", isAdult: true })).toEqual(["coverPath", "isAdult"]);
    expect(changedPendingFields({ ...CHANGES, originalAuthor: null }, { ...CHANGES, originalAuthor: "Homeri" })).toEqual([
      "originalAuthor",
    ]);
  });
});

describe("savePendingChanges", () => {
  it("passes the verified author id and all five values to save_book_pending_changes", async () => {
    const { client, calls } = rpcClient({ data: null, error: null });
    expect(await savePendingChanges(client, { authorId: AUTHOR, bookId: BOOK, expectedVersion: 2, changes: CHANGES })).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        fn: "save_book_pending_changes",
        args: {
          p_author_id: AUTHOR,
          p_book_id: BOOK,
          p_expected_version: 2,
          p_file_path: "f.epub",
          p_cover_path: "c/cover.jpg",
          p_description: "D",
          p_is_adult: false,
          p_original_author: null,
        },
      },
    ]);
  });

  it.each([
    [{ code: "LB490", message: "x" }, "in_review"],
    [{ code: "LB491", message: "x" }, "not_live"],
    [{ code: "LB493", message: "x" }, "adult_category"],
    [{ code: "LB495", message: "x" }, "cover_taken"],
    [{ code: "23505", message: "x" }, "cover_taken"],
    [{ code: "23514", message: "x" }, "invalid"],
    // BD15 P5b-3b: another save came in since the read.
    [{ code: "LB496", message: "x" }, "conflict"],
    [{ code: "P0001", message: "no book found for this id" }, "not_found"],
    [{ code: "XX000", message: "x" }, "failed"],
  ])("maps %o to %s", async (error, reason) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await savePendingChanges(rpcClient({ data: null, error }).client, { authorId: AUTHOR, bookId: BOOK, expectedVersion: 2, changes: CHANGES })).toEqual({
      ok: false,
      reason,
    });
    vi.restoreAllMocks();
  });

  it("a throw is a failure, never thrown on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await savePendingChanges(rpcClient("throw").client, { authorId: AUTHOR, bookId: BOOK, expectedVersion: 2, changes: CHANGES })).toEqual({
      ok: false,
      reason: "failed",
    });
    vi.restoreAllMocks();
  });
});

describe("discardPendingChanges", () => {
  it("passes the verified author id; says whether there was something to discard", async () => {
    const yes = rpcClient({ data: true, error: null });
    expect(await discardPendingChanges(yes.client, { authorId: AUTHOR, bookId: BOOK, expectedVersion: 4 })).toEqual({ ok: true, discarded: true });
    expect(yes.calls).toEqual([
      { fn: "discard_book_pending_changes", args: { p_author_id: AUTHOR, p_book_id: BOOK, p_expected_version: 4 } },
    ]);
    expect(await discardPendingChanges(rpcClient({ data: false, error: null }).client, { authorId: AUTHOR, bookId: BOOK, expectedVersion: null })).toEqual({
      ok: true,
      discarded: false,
    });
  });

  it("maps in review, a missing book and anything else", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const params = { authorId: AUTHOR, bookId: BOOK, expectedVersion: 1 };
    expect(await discardPendingChanges(rpcClient({ data: null, error: { code: "LB490", message: "x" } }).client, params)).toEqual({
      ok: false,
      reason: "in_review",
    });
    expect(await discardPendingChanges(rpcClient({ data: null, error: { code: "LB496", message: "x" } }).client, params)).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect(
      await discardPendingChanges(rpcClient({ data: null, error: { code: "P0001", message: "no book found for this id" } }).client, params),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await discardPendingChanges(rpcClient({ data: null, error: { code: "XX000", message: "x" } }).client, params)).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await discardPendingChanges(rpcClient("throw").client, params)).toEqual({ ok: false, reason: "failed" });
    vi.restoreAllMocks();
  });
});

// BD15 P5b-3b (Renato 11-05, Q2 a): account deletion's read.
describe("readPendingChangesForBooks", () => {
  const OTHER = "d4e5f6a7-3333-4333-8333-abcdef333333";
  function listClient(result: { data: unknown; error: unknown } | "throw") {
    const filters: unknown[] = [];
    const chain = {
      select: (columns: string) => (filters.push(["select", columns]), chain),
      in: (column: string, values: unknown) => (filters.push(["in", column, values]), chain),
      returns: async () => {
        if (result === "throw") throw new Error("boom");
        return result;
      },
    };
    const client = { from: (table: string) => (filters.push(["from", table]), chain) };
    return { client: client as never, filters };
  }
  const row = (book_id: string) => ({
    book_id,
    file_path: `${book_id}.epub`,
    cover_path: "c/cover.jpg",
    description: "D",
    is_adult: false,
    original_author: null,
  });

  it("reads the given books once, deduplicated, and maps each row", async () => {
    const { client, filters } = listClient({ data: [row(BOOK)], error: null });
    const read = await readPendingChangesForBooks(client, [BOOK, OTHER, BOOK]);
    expect(filters).toContainEqual(["from", "book_pending_changes"]);
    expect(filters).toContainEqual(["in", "book_id", [BOOK, OTHER]]);
    expect(read.ok && Object.fromEntries(read.byBook)).toEqual({
      [BOOK]: { filePath: `${BOOK}.epub`, coverPath: "c/cover.jpg", description: "D", isAdult: false, originalAuthor: null },
    });
  });

  it("no books: no read", async () => {
    const { client, filters } = listClient("throw");
    const read = await readPendingChangesForBooks(client, []);
    expect(read.ok && read.byBook.size).toBe(0);
    expect(filters).toEqual([]);
  });

  it("an error, a throw, a non-list or a row of another book is a failed read", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const result of [
      { data: null, error: { code: "XX000" } },
      { data: { not: "a list" }, error: null },
      { data: [row(OTHER)], error: null },
      "throw" as const,
    ]) {
      expect(await readPendingChangesForBooks(listClient(result).client, [BOOK])).toEqual({ ok: false });
    }
    vi.restoreAllMocks();
  });
});
