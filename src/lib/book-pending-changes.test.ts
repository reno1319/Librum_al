import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { changedPendingFields, discardPendingChanges, readPendingChanges, savePendingChanges } = await import(
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
      data: { book_id: BOOK, file_path: "f.epub", cover_path: "c/cover.jpg", description: "D", is_adult: true, original_author: "Homeri" },
      error: null,
    });
    expect(await readPendingChanges(client, BOOK)).toEqual({
      ok: true,
      pending: { filePath: "f.epub", coverPath: "c/cover.jpg", description: "D", isAdult: true, originalAuthor: "Homeri" },
    });
    expect(filters).toContainEqual(["from", "book_pending_changes"]);
    expect(filters).toContainEqual(["eq", "book_id", BOOK]);
  });

  it("no row is no waiting changes", async () => {
    expect(await readPendingChanges(readClient({ data: null, error: null }).client, BOOK)).toEqual({ ok: true, pending: null });
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
    expect(await savePendingChanges(client, { authorId: AUTHOR, bookId: BOOK, changes: CHANGES })).toEqual({ ok: true });
    expect(calls).toEqual([
      {
        fn: "save_book_pending_changes",
        args: {
          p_author_id: AUTHOR,
          p_book_id: BOOK,
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
    [{ code: "P0001", message: "no book found for this id" }, "not_found"],
    [{ code: "XX000", message: "x" }, "failed"],
  ])("maps %o to %s", async (error, reason) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await savePendingChanges(rpcClient({ data: null, error }).client, { authorId: AUTHOR, bookId: BOOK, changes: CHANGES })).toEqual({
      ok: false,
      reason,
    });
    vi.restoreAllMocks();
  });

  it("a throw is a failure, never thrown on", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await savePendingChanges(rpcClient("throw").client, { authorId: AUTHOR, bookId: BOOK, changes: CHANGES })).toEqual({
      ok: false,
      reason: "failed",
    });
    vi.restoreAllMocks();
  });
});

describe("discardPendingChanges", () => {
  it("passes the verified author id; says whether there was something to discard", async () => {
    const yes = rpcClient({ data: true, error: null });
    expect(await discardPendingChanges(yes.client, { authorId: AUTHOR, bookId: BOOK })).toEqual({ ok: true, discarded: true });
    expect(yes.calls).toEqual([{ fn: "discard_book_pending_changes", args: { p_author_id: AUTHOR, p_book_id: BOOK } }]);
    expect(await discardPendingChanges(rpcClient({ data: false, error: null }).client, { authorId: AUTHOR, bookId: BOOK })).toEqual({
      ok: true,
      discarded: false,
    });
  });

  it("maps in review, a missing book and anything else", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const params = { authorId: AUTHOR, bookId: BOOK };
    expect(await discardPendingChanges(rpcClient({ data: null, error: { code: "LB490", message: "x" } }).client, params)).toEqual({
      ok: false,
      reason: "in_review",
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
