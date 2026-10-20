import { beforeEach, describe, expect, it, vi } from "vitest";

// ADMIN-3-REVIEW (H, S6): the staff "Open the book file" link.
// requireStaff("books.review") first; a 5-minute signed URL only for a
// pending review whose snapshot is the book's current, own file; never
// cached; nothing else reaches Storage.

class StaffRedirect extends Error {}
const mockRequireStaff = vi.fn(async (_permission: string) => ({ userId: "staff-1", role: "admin" }));
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

type Result = { data: unknown; error: unknown };
let rows: Record<string, Result>;
const reads: { table: string; columns: string; id: unknown }[] = [];
const mockSign = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      const call = { table, columns: "", id: undefined as unknown };
      const chain = {
        select: (columns: string) => ((call.columns = columns), chain),
        eq: (_column: string, value: unknown) => ((call.id = value), chain),
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
const BOOK = "22222222-2222-4222-8222-222222222222";
const REVIEW = "55555555-5555-4555-8555-555555555555";
const FILE = `${AUTHOR}/${BOOK}/0f0e0d0c-0b0a-4908-8706-050403020100.epub`;
const SIGNED = "https://storage.example/signed?token=abc";

function call(review: string | null = REVIEW, id = BOOK) {
  const url = `https://librum.example/admin/books/${id}/file${review === null ? "" : `?review=${review}`}`;
  return GET(new Request(url), { params: Promise.resolve({ id }) });
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
    book_reviews: { data: { id: REVIEW, book_id: BOOK, status: "pending", file_path: FILE }, error: null },
    books: { data: { id: BOOK, author_id: AUTHOR, file_path: FILE }, error: null },
  };
});

describe("GET /admin/books/[id]/file", () => {
  it("requires books.review before anything else", async () => {
    mockRequireStaff.mockRejectedValue(new StaffRedirect("to login"));
    await expect(call()).rejects.toBeInstanceOf(StaffRedirect);
    expect(mockRequireStaff).toHaveBeenCalledWith("books.review");
    expect(reads).toEqual([]);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("redirects to a 5-minute signed download of the pending snapshot, never cached", async () => {
    const response = await call();
    expect(response.status).toBe(307);
    expect(target(response)).toBe(SIGNED);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(mockSign).toHaveBeenCalledWith("manuscripts", FILE, 300, { download: true });
    expect(reads.map((r) => [r.table, r.id])).toEqual([
      ["book_reviews", REVIEW],
      ["books", BOOK],
    ]);
  });

  it("the author changed the file since: says so, signs nothing", async () => {
    rows.books = { data: { id: BOOK, author_id: AUTHOR, file_path: `${AUTHOR}/${BOOK}.epub` }, error: null };
    const response = await call();
    expect(target(response)).toBe(`/admin/books/${BOOK}?error=The author changed the file. Reload.`);
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(mockSign).not.toHaveBeenCalled();
  });

  it.each([
    ["no review id", () => undefined, null],
    ["a malformed review id", () => undefined, "not-a-uuid"],
    ["a review no longer pending", () => (rows.book_reviews = { data: { id: REVIEW, book_id: BOOK, status: "approved", file_path: FILE }, error: null }), REVIEW],
    ["a review of another book", () => (rows.book_reviews = { data: { id: REVIEW, book_id: AUTHOR, status: "pending", file_path: FILE }, error: null }), REVIEW],
    ["a review read error", () => (rows.book_reviews = { data: null, error: { code: "42501" } }), REVIEW],
    ["a missing book", () => (rows.books = { data: null, error: null }), REVIEW],
    [
      "a snapshot that is not the author's own key",
      () => {
        const foreign = `${BOOK}/${AUTHOR}.epub`;
        rows.book_reviews = { data: { id: REVIEW, book_id: BOOK, status: "pending", file_path: foreign }, error: null };
        rows.books = { data: { id: BOOK, author_id: AUTHOR, file_path: foreign }, error: null };
      },
      REVIEW,
    ],
    [
      "no file at all",
      () => {
        rows.book_reviews = { data: { id: REVIEW, book_id: BOOK, status: "pending", file_path: null }, error: null };
        rows.books = { data: { id: BOOK, author_id: AUTHOR, file_path: null }, error: null };
      },
      REVIEW,
    ],
  ])("%s: file unavailable, nothing signed", async (_label, arrange, review) => {
    arrange();
    expect(target(await call(review as string | null))).toBe(UNAVAILABLE);
    expect(mockSign).not.toHaveBeenCalled();
  });

  it("a malformed book id goes back to the list", async () => {
    expect(target(await call(REVIEW, "../x"))).toBe(`/admin/books?error=That file isn't available.`);
    expect(reads).toEqual([]);
  });

  it("a signing error is file unavailable", async () => {
    mockSign.mockResolvedValue({ data: null, error: { message: "boom" } });
    expect(target(await call())).toBe(UNAVAILABLE);
  });
});
