import { describe, expect, it, vi } from "vitest";
import {
  BOOK_FIXTURE_AUTHOR_ID as AUTHOR,
  BOOK_FIXTURE_BOOK_ID as BOOK,
  BOOK_FIXTURE_OTHER_AUTHOR_ID as OTHER_AUTHOR,
  BOOK_FIXTURE_OTHER_BOOK_ID as OTHER_BOOK,
} from "./book-storage-path-test-fixtures";
import {
  earlierFileLine,
  formatFileSize,
  readEarlierBookFilePath,
  readEarlierBookFiles,
  readFileVersionPaths,
} from "./book-file-versions";

// FV1 (Renato 24-25 Nov 2026): the reads of book_file_versions and the
// two lists' text. The table and its trigger are pinned by the SQL suite
// (116); retention and deletion by book-reviews.test.ts and the deletion
// suites.

const V1 = `${AUTHOR}/${BOOK}/0f0e0d0c-0b0a-4908-8706-050403020100.epub`;
const V2 = `${AUTHOR}/${BOOK}/1a1b1c1d-2a2b-4c3c-8d4d-5e5f6a6b7c7d.epub`;
const VERSION_ID = "7c7d8e8f-9a9b-4cac-8dbd-0e0f1a1b2c2d";

type Recorded = { table: string; columns?: string; filters: unknown[][] };

function client(result: { data: unknown; error: unknown }, sizes: Record<string, unknown> = {}) {
  const recorded: Recorded[] = [];
  const infos: string[] = [];
  const c = {
    from: (table: string) => {
      const call: Recorded = { table, filters: [] };
      recorded.push(call);
      const chain: Record<string, unknown> = {
        select: (columns: string) => ((call.columns = columns), chain),
        eq: (column: string, value: unknown) => (call.filters.push(["eq", column, value]), chain),
        in: (column: string, value: unknown) => (call.filters.push(["in", column, value]), chain),
        not: (column: string, op: string, value: unknown) => (call.filters.push(["not", column, op, value]), chain),
        order: (column: string, opts: unknown) => (call.filters.push(["order", column, opts]), chain),
        returns: () => chain,
        maybeSingle: async () => result,
        then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(result).then(f, r),
      };
      return chain;
    },
    storage: {
      from: (bucket: string) => ({
        info: async (path: string) => {
          infos.push(`${bucket}:${path}`);
          const size = sizes[path];
          if (size === "throw") throw new Error("boom");
          return size === undefined ? { data: null, error: { message: "nope" } } : { data: { size }, error: null };
        },
      }),
    },
  };
  return { client: c as never, recorded, infos };
}

describe("readFileVersionPaths", () => {
  it("one read by book id, grouped by book", async () => {
    const { client: c, recorded } = client({
      data: [
        { book_id: BOOK, file_path: V1 },
        { book_id: BOOK, file_path: V2 },
        { book_id: OTHER_BOOK, file_path: "x" },
      ],
      error: null,
    });
    const read = await readFileVersionPaths(c, [BOOK, OTHER_BOOK, BOOK]);
    expect(recorded).toEqual([{ table: "book_file_versions", columns: "book_id, file_path", filters: [["in", "book_id", [BOOK, OTHER_BOOK]]] }]);
    expect(read).toEqual({ ok: true, byBook: new Map([[BOOK, [V1, V2]], [OTHER_BOOK, ["x"]]]) });
  });

  it("no books: no read", async () => {
    const { client: c, recorded } = client({ data: [], error: null });
    expect(await readFileVersionPaths(c, [])).toEqual({ ok: true, byBook: new Map() });
    expect(recorded).toEqual([]);
  });

  it("fails closed on an error or a non-list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readFileVersionPaths(client({ data: null, error: { code: "42501" } }).client, [BOOK])).toEqual({ ok: false });
    expect(await readFileVersionPaths(client({ data: { book_id: BOOK }, error: null }).client, [BOOK])).toEqual({ ok: false });
    vi.restoreAllMocks();
  });
});

describe("readEarlierBookFiles", () => {
  it("replaced rows only, newest first, own keys only, each with its stored size", async () => {
    const { client: c, recorded, infos } = client(
      {
        data: [
          { id: "b", file_path: V2, live_from: "2026-11-02T10:00:00Z", replaced_at: "2026-11-20T10:00:00Z" },
          { id: "a", file_path: V1, live_from: "2026-10-05T10:00:00Z", replaced_at: "2026-11-02T10:00:00Z" },
          { id: "x", file_path: `${OTHER_AUTHOR}/${BOOK}.epub`, live_from: "2026-10-01T10:00:00Z", replaced_at: "2026-10-02T10:00:00Z" },
          { id: "y", file_path: `${AUTHOR}/${OTHER_BOOK}.epub`, live_from: "2026-10-01T10:00:00Z", replaced_at: "2026-10-02T10:00:00Z" },
          { id: "z", file_path: V1, live_from: "2026-10-01T10:00:00Z", replaced_at: null },
        ],
        error: null,
      },
      { [V2]: 1363149, [V1]: "throw" },
    );
    const files = await readEarlierBookFiles(c, { id: BOOK, authorId: AUTHOR });
    expect(recorded).toEqual([
      {
        table: "book_file_versions",
        columns: "id, file_path, live_from, replaced_at",
        filters: [["eq", "book_id", BOOK], ["not", "replaced_at", "is", null], ["order", "replaced_at", { ascending: false }]],
      },
    ]);
    expect(files).toEqual([
      { id: "b", liveFrom: "2026-11-02T10:00:00Z", replacedAt: "2026-11-20T10:00:00Z", sizeBytes: 1363149 },
      { id: "a", liveFrom: "2026-10-05T10:00:00Z", replacedAt: "2026-11-02T10:00:00Z", sizeBytes: null },
    ]);
    expect(infos).toEqual([`manuscripts:${V2}`, `manuscripts:${V1}`]);
  });

  it("null when the list can't be read, with no key in the log", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readEarlierBookFiles(client({ data: null, error: { code: "57014" } }).client, { id: BOOK, authorId: AUTHOR })).toBeNull();
    expect(JSON.stringify(errors.mock.calls)).not.toContain(AUTHOR);
    vi.restoreAllMocks();
  });
});

describe("readEarlierBookFilePath", () => {
  const row = { id: VERSION_ID, file_path: V1, live_from: "2026-10-05T10:00:00Z", replaced_at: "2026-11-02T10:00:00Z" };

  it("this book's replaced row, by id AND book id", async () => {
    const { client: c, recorded } = client({ data: row, error: null });
    expect(await readEarlierBookFilePath(c, { id: BOOK, authorId: AUTHOR }, VERSION_ID)).toEqual({
      kind: "ok",
      filePath: V1,
      liveFrom: "2026-10-05T10:00:00Z",
    });
    expect(recorded[0].filters).toEqual([["eq", "id", VERSION_ID], ["eq", "book_id", BOOK]]);
  });

  it("missing: no row, the current file (not replaced), or not the book's own key", async () => {
    for (const data of [null, { ...row, replaced_at: null }, { ...row, file_path: `${OTHER_AUTHOR}/${BOOK}.epub` }, { ...row, file_path: `${AUTHOR}/${BOOK}/../x.epub` }]) {
      expect(await readEarlierBookFilePath(client({ data, error: null }).client, { id: BOOK, authorId: AUTHOR }, VERSION_ID)).toEqual({ kind: "missing" });
    }
  });

  it("error when the read fails, even with a plausible row", async () => {
    expect(await readEarlierBookFilePath(client({ data: row, error: { code: "57014" } }).client, { id: BOOK, authorId: AUTHOR }, VERSION_ID)).toEqual({ kind: "error" });
  });
});

describe("the list's text", () => {
  it("sizes: KB under 1 MB, one decimal, Albanian comma", () => {
    expect(formatFileSize(1363149, "sq")).toBe("1,3 MB");
    expect(formatFileSize(1363149, "en")).toBe("1.3 MB");
    expect(formatFileSize(2 * 1024 * 1024, "sq")).toBe("2 MB");
    expect(formatFileSize(512 * 1024, "sq")).toBe("512 KB");
    expect(formatFileSize(0, "en")).toBe("1 KB");
  });

  it("one row, as in the approved pictures, days in Tirana", () => {
    const file = { id: "a", liveFrom: "2026-10-05T10:00:00Z", replacedAt: "2026-11-02T23:30:00Z", sizeBytes: 1258291 };
    expect(earlierFileLine(file, "sq")).toBe("skedar EPUB · në shitje 5 tetor 2026 – 3 nëntor 2026 · 1,2 MB");
    expect(earlierFileLine(file, "en")).toBe("EPUB · live 5 Oct 2026 – 3 Nov 2026 · 1.2 MB");
    expect(earlierFileLine({ ...file, sizeBytes: null }, "sq")).toBe("skedar EPUB · në shitje 5 tetor 2026 – 3 nëntor 2026");
  });
});
