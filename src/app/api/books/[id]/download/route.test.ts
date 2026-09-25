import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";
import {
  BOOK_FIXTURE_AUTHOR_ID,
  BOOK_FIXTURE_BOOK_ID,
  UNSAFE_MANUSCRIPT_PATHS,
} from "@/lib/book-storage-path-test-fixtures";

// LAUNCH-1 P1-11: minimal, focused coverage of ONLY the new recovery
// guard added to this Route Handler -- not a re-test of its own
// pre-existing ownership/entitlement logic (that stays untouched and
// uncovered here). Uses a 403 JSON response, not a redirect, per the
// audit's own conclusion for API/download-shaped endpoints -- see the
// route's own comment.
//
// LAUNCH-1 P3-2: recoveryActive is now a mutable flag (default false)
// rather than the cookie always reading "active" -- the original
// fixture only ever needed to prove the recovery-active case, but the
// new tests below need to get PAST this guard to reach ownership/
// watermark logic, so the fixture now supports both.
//
// MANUSCRIPT-DELIVERY-STORAGE-AUTH-1: fixtures are real lowercase UUIDs
// and the canonical `<author id>/<book id>.epub` key, so a success test
// can only pass through the real canonical-path check. The fake Supabase
// client records the selected columns, the id filter and the RPC
// arguments; the fake admin client records the bucket and key.
let recoveryActive = false;
const mockCookieStore = {
  get: vi.fn((name: string) =>
    name === RECOVERY_COOKIE_NAME && recoveryActive ? { value: "1" } : undefined,
  ),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));
const mockWatermarkEpub = vi.fn();
vi.mock("@/lib/watermark", () => ({
  watermarkEpub: (...args: unknown[]) => mockWatermarkEpub(...args),
}));

const { GET } = await import("./route");

const AUTHOR_ID = "3f2a8c1e-5b7d-4e9a-8c6f-1a2b3c4d5e6f";
const BOOK_ID = "9d8c7b6a-5f4e-4d3c-9b2a-1f0e9d8c7b6a";
const READER_ID = "c0ffee00-1234-4abc-9def-0123456789ab";
const OTHER_AUTHOR_ID = "7e6d5c4b-3a29-4817-8a6b-5c4d3e2f1a0b";
const OTHER_BOOK_ID = "2b3c4d5e-6f70-4812-9a3b-4c5d6e7f8091";
const READER_EMAIL = "reader@example.com";
const CANONICAL_PATH = `${AUTHOR_ID}/${BOOK_ID}.epub`;
const EXPECTED_COLUMNS = "id, author_id, file_path, title";
const FILE_UNAVAILABLE = `/books/${BOOK_ID}?error=That+file+isn%27t+available`;
const BUY_FIRST = `/books/${BOOK_ID}?error=Buy+this+book+to+download+it`;

// Every value here is refused for a row whose id is BOOK_ID and whose
// author_id is AUTHOR_ID. Strings are also asserted never to appear in a
// log line or a response.
const INVALID_STRING_PATHS: Array<[string, string]> = [
  ["another author's canonical manuscript", `${OTHER_AUTHOR_ID}/${OTHER_BOOK_ID}.epub`],
  ["another author's folder, this book id", `${OTHER_AUTHOR_ID}/${BOOK_ID}.epub`],
  ["the same author's other book", `${AUTHOR_ID}/${OTHER_BOOK_ID}.epub`],
  ["traversal into another author", `${AUTHOR_ID}/../${OTHER_AUTHOR_ID}/${OTHER_BOOK_ID}.epub`],
  ["traversal that resolves to itself", `${AUTHOR_ID}/../${AUTHOR_ID}/${BOOK_ID}.epub`],
  ["dot segment", `${AUTHOR_ID}/./${BOOK_ID}.epub`],
  ["traversal out of the bucket", `../covers/${AUTHOR_ID}/${BOOK_ID}-cover.png`],
  ["encoded traversal", `${AUTHOR_ID}/%2e%2e/${OTHER_AUTHOR_ID}/${OTHER_BOOK_ID}.epub`],
  ["upper-case encoded traversal", `${AUTHOR_ID}/%2E%2E/${AUTHOR_ID}/${BOOK_ID}.epub`],
  ["encoded slash", `${AUTHOR_ID}%2F${BOOK_ID}.epub`],
  ["percent-encoded canonical", encodeURIComponent(CANONICAL_PATH)],
  ["bucket-qualified", `manuscripts/${CANONICAL_PATH}`],
  ["storage-API object path", `/storage/v1/object/manuscripts/${CANONICAL_PATH}`],
  ["storage-API relative object path", `object/manuscripts/${CANONICAL_PATH}`],
  ["absolute storage URL", `https://abcdefghijklmnopqrst.supabase.co/storage/v1/object/manuscripts/${CANONICAL_PATH}`],
  ["leading slash", `/${CANONICAL_PATH}`],
  ["double slash", `${AUTHOR_ID}//${BOOK_ID}.epub`],
  ["trailing slash", `${CANONICAL_PATH}/`],
  ["upper-case author UUID", `${AUTHOR_ID.toUpperCase()}/${BOOK_ID}.epub`],
  ["upper-case book UUID", `${AUTHOR_ID}/${BOOK_ID.toUpperCase()}.epub`],
  ["upper-case extension", `${AUTHOR_ID}/${BOOK_ID}.EPUB`],
  ["mixed-case extension", `${AUTHOR_ID}/${BOOK_ID}.Epub`],
  ["wrong extension", `${AUTHOR_ID}/${BOOK_ID}.pdf`],
  ["double extension", `${AUTHOR_ID}/${BOOK_ID}.epub.epub`],
  ["hidden second extension", `${AUTHOR_ID}/${BOOK_ID}.pdf.epub`],
  ["no extension", `${AUTHOR_ID}/${BOOK_ID}`],
  ["cover key", `${AUTHOR_ID}/${BOOK_ID}-cover.png`],
  ["author-id prefix confusion", `${AUTHOR_ID}x/${BOOK_ID}.epub`],
  ["book-id prefix confusion", `${AUTHOR_ID}/${BOOK_ID}0.epub`],
  ["book-id only", `${BOOK_ID}.epub`],
  ["query string", `${CANONICAL_PATH}?download=1`],
  ["fragment", `${CANONICAL_PATH}#x`],
  ["leading whitespace", ` ${CANONICAL_PATH}`],
  ["trailing whitespace", `${CANONICAL_PATH} `],
  ["trailing newline", `${CANONICAL_PATH}\n`],
  ["embedded null byte", `${CANONICAL_PATH}\u0000`],
  ["empty string", ""],
];

const INVALID_NON_STRING_PATHS: Array<[string, unknown]> = [
  ["null", null],
  ["undefined", undefined],
  ["number", 42],
  ["object", { path: CANONICAL_PATH }],
  ["array", [CANONICAL_PATH]],
  ["boolean", true],
];

type QueryResult = { data: unknown; error: unknown };

function makeFakeSupabase(overrides: {
  userId?: string | null;
  userEmail?: string | null;
  bookResult?: QueryResult;
  ownsBookRpcResult?: unknown;
  ownsBookRpcError?: unknown;
} = {}) {
  const {
    userId = AUTHOR_ID,
    userEmail = READER_EMAIL,
    bookResult = {
      data: { id: BOOK_ID, author_id: AUTHOR_ID, file_path: CANONICAL_PATH, title: "Test Book" },
      error: null,
    },
    ownsBookRpcResult = false,
    ownsBookRpcError = null,
  } = overrides;

  const single = vi.fn(() => Promise.resolve(bookResult));
  const eq = vi.fn(() => ({ single }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const rpc = vi.fn(() => Promise.resolve({ data: ownsBookRpcResult, error: ownsBookRpcError }));

  return {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: userId ? { id: userId, email: userEmail ?? undefined } : null },
        }),
    },
    from,
    rpc,
    __from: from,
    __select: select,
    __eq: eq,
    __single: single,
    __rpc: rpc,
  };
}

function bookRow(overrides: Record<string, unknown> = {}): QueryResult {
  return {
    data: { id: BOOK_ID, author_id: AUTHOR_ID, file_path: CANONICAL_PATH, title: "Test Book", ...overrides },
    error: null,
  };
}

function makeFakeAdminClient(overrides: { fileBytes?: Buffer; downloadError?: unknown } = {}) {
  const { fileBytes = Buffer.from("fake epub bytes"), downloadError = null } = overrides;
  const download = vi.fn((_path: string) =>
    Promise.resolve(
      downloadError
        ? { data: null, error: downloadError }
        : { data: new Blob([new Uint8Array(fileBytes)]), error: null },
    ),
  );
  const from = vi.fn((_bucket: string) => ({ download }));
  return { storage: { from }, __from: from, __download: download };
}

function makeRequest() {
  return new Request(`https://librumal.vercel.app/api/books/${BOOK_ID}/download`);
}

function callRoute() {
  return GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });
}

function redirectTarget(response: Response): string {
  const location = response.headers.get("location");
  if (!location) throw new Error("expected a redirect");
  const url = new URL(location);
  return `${url.pathname}${url.search}`;
}

describe("GET /api/books/[id]/download", () => {
  const logSpies: Array<ReturnType<typeof vi.spyOn>> = [];
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  function allLogOutput(): string {
    return JSON.stringify(logSpies.map((spy) => spy.mock.calls));
  }

  beforeEach(() => {
    recoveryActive = false;
    mockCreateClient.mockReset();
    mockCreateAdminClient.mockReset();
    mockWatermarkEpub.mockReset();
    logSpies.length = 0;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    logSpies.push(
      warnSpy,
      errorSpy,
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    );
  });

  afterEach(() => {
    for (const spy of logSpies) spy.mockRestore();
  });

  describe("recovery-session defense-in-depth", () => {
    it("returns 403 and never reaches Supabase when a recovery session is active", async () => {
      recoveryActive = true;

      const response = await callRoute();

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/password/i);
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(mockWatermarkEpub).not.toHaveBeenCalled();
    });
  });

  describe("unauthenticated", () => {
    it("redirects to login without reading the book or touching Storage", async () => {
      const supabase = makeFakeSupabase({ userId: null });
      mockCreateClient.mockResolvedValue(supabase);

      const response = await callRoute();

      expect(response.status).toBe(307);
      expect(redirectTarget(response)).toBe(`/login?next=/books/${BOOK_ID}`);
      expect(supabase.__from).not.toHaveBeenCalled();
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
    });
  });

  describe("row identity binding", () => {
    it("selects exactly id, author_id, file_path, title for the route's own id", async () => {
      const supabase = makeFakeSupabase();
      mockCreateClient.mockResolvedValue(supabase);
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient());
      mockWatermarkEpub.mockResolvedValue({ watermarked: true, bytes: Buffer.from("w") });

      await callRoute();

      expect(supabase.__from).toHaveBeenCalledTimes(1);
      expect(supabase.__from).toHaveBeenCalledWith("books");
      expect(supabase.__select).toHaveBeenCalledTimes(1);
      expect(supabase.__select).toHaveBeenCalledWith(EXPECTED_COLUMNS);
      expect(supabase.__eq).toHaveBeenCalledTimes(1);
      expect(supabase.__eq).toHaveBeenCalledWith("id", BOOK_ID);
      expect(supabase.__single).toHaveBeenCalledTimes(1);
    });

    it("the entitlement RPC is asked about the row's own id", async () => {
      const supabase = makeFakeSupabase({ userId: READER_ID, ownsBookRpcResult: true });
      mockCreateClient.mockResolvedValue(supabase);
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient());
      mockWatermarkEpub.mockResolvedValue({ watermarked: true, bytes: Buffer.from("w") });

      await callRoute();

      expect(supabase.__rpc).toHaveBeenCalledTimes(1);
      expect(supabase.__rpc).toHaveBeenCalledWith("user_owns_book", { target_book_id: BOOK_ID });
    });
  });

  describe("canonical own manuscript", () => {
    it("the author downloads exactly <author>/<book>.epub from the manuscripts bucket", async () => {
      const adminClient = makeFakeAdminClient();
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(adminClient);
      mockWatermarkEpub.mockResolvedValue({ watermarked: true, bytes: Buffer.from("watermarked") });

      const response = await callRoute();

      expect(response.status).toBe(200);
      expect(mockCreateAdminClient).toHaveBeenCalledTimes(1);
      expect(adminClient.__from).toHaveBeenCalledTimes(1);
      expect(adminClient.__from).toHaveBeenCalledWith("manuscripts");
      expect(adminClient.__download).toHaveBeenCalledTimes(1);
      expect(adminClient.__download).toHaveBeenCalledWith(CANONICAL_PATH);
      expect(response.headers.get("content-disposition")).toBe('attachment; filename="test-book.epub"');
    });

    it("an entitled non-author reader downloads the author's canonical manuscript", async () => {
      const adminClient = makeFakeAdminClient();
      mockCreateClient.mockResolvedValue(makeFakeSupabase({ userId: READER_ID, ownsBookRpcResult: true }));
      mockCreateAdminClient.mockReturnValue(adminClient);
      mockWatermarkEpub.mockResolvedValue({ watermarked: true, bytes: Buffer.from("watermarked") });

      const response = await callRoute();

      expect(response.status).toBe(200);
      expect(adminClient.__download).toHaveBeenCalledWith(CANONICAL_PATH);
      expect(mockWatermarkEpub).toHaveBeenCalledTimes(1);
    });

    it("an entitled reader cannot pull a manuscript filed under the reader's own id", async () => {
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          userId: READER_ID,
          ownsBookRpcResult: true,
          bookResult: bookRow({ file_path: `${READER_ID}/${BOOK_ID}.epub` }),
        }),
      );

      const response = await callRoute();

      expect(redirectTarget(response)).toBe(FILE_UNAVAILABLE);
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
    });
  });

  describe("successful watermark", () => {
    it("serves the watermarked bytes with 200, and logs nothing", async () => {
      const fileBytes = Buffer.from("original epub bytes");
      const watermarkedBytes = Buffer.from("watermarked epub bytes");
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));
      mockWatermarkEpub.mockResolvedValue({ watermarked: true, bytes: watermarkedBytes });

      const response = await callRoute();

      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(watermarkedBytes)).toBe(true);
      expect(mockWatermarkEpub).toHaveBeenCalledTimes(1);
      const [bytesArg, emailArg] = mockWatermarkEpub.mock.calls[0];
      expect(Buffer.from(bytesArg as Buffer).equals(fileBytes)).toBe(true);
      expect(emailArg).toBe(READER_EMAIL);
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe("unsupported-structure fallback", () => {
    it("still serves 200 with the ORIGINAL bytes, logs exactly one console.warn, never console.error", async () => {
      const fileBytes = Buffer.from("original epub bytes");
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));
      mockWatermarkEpub.mockResolvedValue({
        watermarked: false,
        bytes: fileBytes,
        failureStage: "unsupported_structure",
      });

      const response = await callRoute();

      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(fileBytes)).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
    });
  });

  describe("unexpected-exception fallback", () => {
    it("still serves 200 with the ORIGINAL bytes, logs exactly one console.error, never console.warn", async () => {
      const fileBytes = Buffer.from("original epub bytes");
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));
      mockWatermarkEpub.mockResolvedValue({
        watermarked: false,
        bytes: fileBytes,
        failureStage: "unexpected_exception",
      });

      const response = await callRoute();

      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(fileBytes)).toBe(true);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("missing reader email", () => {
    it("never calls watermarkEpub, serves 200 with the original bytes, logs exactly one console.warn with stage='missing_reader_email'", async () => {
      const fileBytes = Buffer.from("original epub bytes");
      mockCreateClient.mockResolvedValue(makeFakeSupabase({ userEmail: null }));
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));

      const response = await callRoute();

      expect(mockWatermarkEpub).not.toHaveBeenCalled();
      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(fileBytes)).toBe(true);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).not.toHaveBeenCalled();
      const [, payload] = warnSpy.mock.calls[0];
      expect(payload).toMatchObject({ stage: "missing_reader_email" });
    });
  });

  describe("safe log context", () => {
    it("fallback log contains exactly bookId/readerId/byteSize/stage, and never the email, manuscript contents, or storage path", async () => {
      const fileBytes = Buffer.from("original epub bytes -- should never appear in a log");
      mockCreateClient.mockResolvedValue(makeFakeSupabase({ userId: READER_ID, ownsBookRpcResult: true }));
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));
      mockWatermarkEpub.mockResolvedValue({
        watermarked: false,
        bytes: fileBytes,
        failureStage: "unsupported_structure",
      });

      await callRoute();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message, payload] = warnSpy.mock.calls[0];
      expect(message).toBe("Download: served an unwatermarked EPUB (fallback)");
      expect(payload).toEqual({
        bookId: BOOK_ID,
        readerId: READER_ID,
        byteSize: fileBytes.length,
        stage: "unsupported_structure",
      });

      const serialized = JSON.stringify([message, payload]);
      expect(serialized).not.toContain(READER_EMAIL);
      expect(serialized).not.toContain("original epub bytes");
      expect(serialized).not.toContain(CANONICAL_PATH);
    });
  });

  describe("entitlement failure", () => {
    it("redirects before ever downloading the manuscript or calling watermarkEpub", async () => {
      const adminClient = makeFakeAdminClient();
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          userId: READER_ID,
          bookResult: bookRow({
            author_id: OTHER_AUTHOR_ID,
            file_path: `${OTHER_AUTHOR_ID}/${BOOK_ID}.epub`,
          }),
          ownsBookRpcResult: false,
        }),
      );
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await callRoute();

      expect(response.status).toBe(307); // NextResponse.redirect default
      expect(redirectTarget(response)).toBe(BUY_FIRST);
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(mockWatermarkEpub).not.toHaveBeenCalled();
      expect(adminClient.__download).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
    });

    // No path-validity oracle: a caller who may not download the book
    // gets the byte-identical buy-first answer whatever the stored path
    // is, including absent.
    it.each<[string, unknown]>([
      ["canonical", CANONICAL_PATH],
      ["another author's manuscript", `${OTHER_AUTHOR_ID}/${OTHER_BOOK_ID}.epub`],
      ["traversal", `${AUTHOR_ID}/../${OTHER_AUTHOR_ID}/${OTHER_BOOK_ID}.epub`],
      ["null", null],
      ["empty", ""],
      ["non-string", 42],
    ])("a non-entitled caller gets the same buy-first redirect for a %s path", async (_label, filePath) => {
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({ userId: READER_ID, bookResult: bookRow({ file_path: filePath }) }),
      );

      const response = await callRoute();

      expect(response.status).toBe(307);
      expect(redirectTarget(response)).toBe(BUY_FIRST);
      expect(await response.text()).toBe("");
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(mockWatermarkEpub).not.toHaveBeenCalled();
    });

    it("an entitlement RPC error denies even if it also returns true", async () => {
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          userId: READER_ID,
          ownsBookRpcResult: true,
          ownsBookRpcError: { message: "rpc failed" },
        }),
      );

      const response = await callRoute();

      expect(redirectTarget(response)).toBe(BUY_FIRST);
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
    });
  });

  describe("invalid stored manuscript path (entitled author)", () => {
    async function expectRefused(filePath: unknown) {
      const supabase = makeFakeSupabase({ bookResult: bookRow({ file_path: filePath }) });
      mockCreateClient.mockResolvedValue(supabase);
      const adminClient = makeFakeAdminClient();
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await callRoute();

      expect(response.status).toBe(307);
      expect(redirectTarget(response)).toBe(FILE_UNAVAILABLE);
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(adminClient.__from).not.toHaveBeenCalled();
      expect(adminClient.__download).not.toHaveBeenCalled();
      expect(mockWatermarkEpub).not.toHaveBeenCalled();
      return { response, supabase };
    }

    it.each(INVALID_STRING_PATHS)("refuses %s without echoing or logging it", async (_label, filePath) => {
      const { response } = await expectRefused(filePath);

      const location = response.headers.get("location") ?? "";
      const body = await response.text();
      if (filePath.length > 0) {
        expect(location).not.toContain(filePath);
        expect(decodeURIComponent(location)).not.toContain(filePath);
        expect(body).not.toContain(filePath);
        expect(allLogOutput()).not.toContain(JSON.stringify(filePath).slice(1, -1));
      }
      for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
    });

    it.each(INVALID_NON_STRING_PATHS)("refuses a %s file_path", async (_label, filePath) => {
      await expectRefused(filePath);
      for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
    });

    // The same hostile values the canonical rule and deleteAccount are
    // tested against, delivered through this route's own row binding.
    it.each(UNSAFE_MANUSCRIPT_PATHS)("refuses the shared unsafe manuscript value: %s", async (_label, filePath) => {
      const adminClient = makeFakeAdminClient();
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          userId: BOOK_FIXTURE_AUTHOR_ID,
          bookResult: {
            data: { id: BOOK_FIXTURE_BOOK_ID, author_id: BOOK_FIXTURE_AUTHOR_ID, file_path: filePath, title: "T" },
            error: null,
          },
        }),
      );
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_FIXTURE_BOOK_ID }) });

      expect(redirectTarget(response)).toBe(`/books/${BOOK_FIXTURE_BOOK_ID}?error=That+file+isn%27t+available`);
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(adminClient.__download).not.toHaveBeenCalled();
      expect(mockWatermarkEpub).not.toHaveBeenCalled();
      for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
    });

    it("the shared fixture's own canonical key is accepted for its own row", async () => {
      const adminClient = makeFakeAdminClient();
      const canonical = `${BOOK_FIXTURE_AUTHOR_ID}/${BOOK_FIXTURE_BOOK_ID}.epub`;
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          userId: BOOK_FIXTURE_AUTHOR_ID,
          bookResult: {
            data: { id: BOOK_FIXTURE_BOOK_ID, author_id: BOOK_FIXTURE_AUTHOR_ID, file_path: canonical, title: "T" },
            error: null,
          },
        }),
      );
      mockCreateAdminClient.mockReturnValue(adminClient);
      mockWatermarkEpub.mockResolvedValue({ watermarked: true, bytes: Buffer.from("w") });

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_FIXTURE_BOOK_ID }) });

      expect(response.status).toBe(200);
      expect(adminClient.__download).toHaveBeenCalledWith(canonical);
    });

    it("refuses a row with no file_path key at all", async () => {
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({ bookResult: { data: { id: BOOK_ID, author_id: AUTHOR_ID, title: "T" }, error: null } }),
      );

      const response = await callRoute();

      expect(redirectTarget(response)).toBe(FILE_UNAVAILABLE);
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
    });
  });

  describe("database errors and malformed rows fail closed", () => {
    const canonicalRow = { id: BOOK_ID, author_id: AUTHOR_ID, file_path: CANONICAL_PATH, title: "Test Book" };

    it.each<[string, QueryResult]>([
      ["an error with no data", { data: null, error: { message: "db down", code: "XX000" } }],
      ["an error with plausible canonical data", { data: canonicalRow, error: { message: "db down", code: "XX000" } }],
      ["no row", { data: null, error: null }],
      ["an array of rows", { data: [canonicalRow], error: null }],
      ["a string", { data: CANONICAL_PATH, error: null }],
      ["a row without id", { data: { author_id: AUTHOR_ID, file_path: CANONICAL_PATH, title: "T" }, error: null }],
      ["a row for another book id", {
        data: { id: OTHER_BOOK_ID, author_id: AUTHOR_ID, file_path: `${AUTHOR_ID}/${OTHER_BOOK_ID}.epub`, title: "T" },
        error: null,
      }],
      ["a row for another book id carrying the route id's path", {
        data: { id: OTHER_BOOK_ID, author_id: AUTHOR_ID, file_path: CANONICAL_PATH, title: "T" },
        error: null,
      }],
      ["a row whose id differs only in case", {
        data: { ...canonicalRow, id: BOOK_ID.toUpperCase() },
        error: null,
      }],
      ["a row with a numeric id", { data: { ...canonicalRow, id: 7 }, error: null }],
      ["a row without author_id", { data: { id: BOOK_ID, file_path: CANONICAL_PATH, title: "T" }, error: null }],
      ["a row with a non-string author_id", { data: { ...canonicalRow, author_id: 1 }, error: null }],
      ["a row with a non-string title", { data: { ...canonicalRow, title: null }, error: null }],
    ])("%s -> file unavailable, no admin client", async (_label, bookResult) => {
      const adminClient = makeFakeAdminClient();
      mockCreateClient.mockResolvedValue(makeFakeSupabase({ bookResult }));
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await callRoute();

      expect(response.status).toBe(307);
      expect(redirectTarget(response)).toBe(FILE_UNAVAILABLE);
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(adminClient.__download).not.toHaveBeenCalled();
      expect(mockWatermarkEpub).not.toHaveBeenCalled();
      const exposed = `${response.headers.get("location")}${await response.text()}${allLogOutput()}`;
      expect(exposed).not.toContain("db down");
      expect(exposed).not.toContain("XX000");
      expect(exposed).not.toContain(CANONICAL_PATH);
    });
  });

  describe("storage failure", () => {
    it("a Storage error on a canonical path is the existing could-not-download redirect, with no detail", async () => {
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(
        makeFakeAdminClient({ downloadError: { message: "internal storage detail" } }),
      );

      const response = await callRoute();

      expect(redirectTarget(response)).toBe(`/books/${BOOK_ID}?error=Could+not+download+that+file`);
      expect(mockWatermarkEpub).not.toHaveBeenCalled();
      expect(`${response.headers.get("location")}${allLogOutput()}`).not.toContain("internal storage detail");
    });
  });

  describe("no duplicate logging", () => {
    it("exactly one warn+error call total across a single unsupported-structure fallback download", async () => {
      const fileBytes = Buffer.from("original epub bytes");
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));
      mockWatermarkEpub.mockResolvedValue({
        watermarked: false,
        bytes: fileBytes,
        failureStage: "unsupported_structure",
      });

      await callRoute();

      expect(warnSpy.mock.calls.length + errorSpy.mock.calls.length).toBe(1);
    });
  });
});
