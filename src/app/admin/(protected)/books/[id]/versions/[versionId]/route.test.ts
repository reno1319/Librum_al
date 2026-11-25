import { beforeEach, describe, expect, it, vi } from "vitest";

// FV1 (fv2 a): "Download" on an earlier file on the staff book page.
// requireStaff("books.review") first; a 5-minute signed URL only for a
// replaced row of this book whose key is the book's own; never cached;
// nothing else reaches Storage.

class StaffRedirect extends Error {}
const mockRequireStaff = vi.fn(async (_permission: string) => ({ userId: "staff-1", role: "admin" }));
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

type Result = { data: unknown; error: unknown };
let rows: Record<string, Result>;
const reads: { table: string; filters: [string, unknown][] }[] = [];
const mockSign = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const call = { table, filters: [] as [string, unknown][] };
      const chain = {
        select: () => chain,
        eq: (column: string, value: unknown) => (call.filters.push([column, value]), chain),
        maybeSingle: async () => (reads.push(call), rows[table]),
      };
      return chain;
    },
    storage: {
      from: (bucket: string) => ({
        createSignedUrl: (path: string, seconds: number, options: unknown) => mockSign(bucket, path, seconds, options),
      }),
    },
  }),
}));

const { GET } = await import("./route");

const AUTHOR = "66666666-6666-4666-8666-666666666666";
const OTHER_AUTHOR = "77777777-7777-4777-8777-777777777777";
const BOOK = "22222222-2222-4222-8222-222222222222";
const VERSION = "55555555-5555-4555-8555-555555555555";
const FILE = `${AUTHOR}/${BOOK}/0f0e0d0c-0b0a-4908-8706-050403020100.epub`;
const SIGNED = "https://storage.example/signed?token=abc";

function call(versionId = VERSION, id = BOOK) {
  return GET(new Request(`https://librum.example/admin/books/${id}/versions/${versionId}`), {
    params: Promise.resolve({ id, versionId }),
  });
}

function target(response: Response): string {
  const location = response.headers.get("location") ?? "";
  if (location.startsWith("https://librum.example")) {
    const url = new URL(location);
    return decodeURIComponent(`${url.pathname}${url.search}`);
  }
  return location;
}

const UNAVAILABLE = `/admin/books/${BOOK}?error=That file isn't available.`;

beforeEach(() => {
  mockRequireStaff.mockReset().mockResolvedValue({ userId: "staff-1", role: "admin" });
  mockSign.mockReset().mockResolvedValue({ data: { signedUrl: SIGNED }, error: null });
  reads.length = 0;
  rows = {
    books: { data: { id: BOOK, author_id: AUTHOR }, error: null },
    book_file_versions: {
      data: { id: VERSION, file_path: FILE, live_from: "2026-10-05T10:00:00Z", replaced_at: "2026-11-02T10:00:00Z" },
      error: null,
    },
  };
});

describe("GET /admin/books/[id]/versions/[versionId]", () => {
  it("requires books.review before anything else", async () => {
    mockRequireStaff.mockRejectedValue(new StaffRedirect("to login"));
    await expect(call()).rejects.toBeInstanceOf(StaffRedirect);
    expect(mockRequireStaff).toHaveBeenCalledWith("books.review");
    expect(reads).toEqual([]);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("redirects to a 5-minute signed download of the earlier file, never cached", async () => {
    const response = await call();
    expect(response.status).toBe(307);
    expect(target(response)).toBe(SIGNED);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(mockSign).toHaveBeenCalledWith("manuscripts", FILE, 300, { download: true });
    expect(reads).toEqual([
      { table: "books", filters: [["id", BOOK]] },
      { table: "book_file_versions", filters: [["id", VERSION], ["book_id", BOOK]] },
    ]);
  });

  it("anything else is 'not available', with no Storage call", async () => {
    const cases: [string, () => void, string?][] = [
      ["bad version id", () => {}, "not-a-uuid"],
      ["book read error", () => (rows.books = { data: { id: BOOK, author_id: AUTHOR }, error: { code: "57014" } })],
      ["no book", () => (rows.books = { data: null, error: null })],
      ["no row", () => (rows.book_file_versions = { data: null, error: null })],
      ["row read error", () => (rows.book_file_versions = { ...rows.book_file_versions, error: { code: "57014" } })],
      ["still the current file", () => ((rows.book_file_versions.data as Record<string, unknown>).replaced_at = null)],
      ["another author's key", () => ((rows.book_file_versions.data as Record<string, unknown>).file_path = `${OTHER_AUTHOR}/${BOOK}.epub`)],
    ];
    for (const [name, setup, versionId] of cases) {
      mockSign.mockClear();
      rows = {
        books: { data: { id: BOOK, author_id: AUTHOR }, error: null },
        book_file_versions: {
          data: { id: VERSION, file_path: FILE, live_from: "2026-10-05T10:00:00Z", replaced_at: "2026-11-02T10:00:00Z" },
          error: null,
        },
      };
      setup();
      const response = await call(versionId);
      expect(target(response), name).toBe(UNAVAILABLE);
      expect(response.headers.get("cache-control"), name).toBe("no-store, max-age=0");
      expect(mockSign, name).not.toHaveBeenCalled();
    }
  });

  it("a failed signing is 'not available'", async () => {
    mockSign.mockResolvedValue({ data: null, error: { message: "nope" } });
    expect(target(await call())).toBe(UNAVAILABLE);
  });

  it("a bad book id goes back to the books list", async () => {
    expect(target(await call(VERSION, "nope"))).toBe("/admin/books?error=That file isn't available.");
    expect(reads).toEqual([]);
  });
});
