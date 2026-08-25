import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

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

const BOOK_ID = "book-1";
const READER_ID = "reader-1";
const READER_EMAIL = "reader@example.com";

// Owner-by-authorship is the simplest ownership shape (no rpc mock
// needed) -- used for every test that isn't specifically about the
// entitlement-failure path itself, per "do not build unrelated
// ownership-test architecture beyond what is necessary."
function makeFakeSupabase(overrides: {
  userId?: string | null;
  userEmail?: string | null;
  book?: { file_path: string | null; title: string; author_id: string } | null;
  ownsBookRpcResult?: boolean;
} = {}) {
  const {
    userId = READER_ID,
    userEmail = READER_EMAIL,
    book = { file_path: "author-1/book-1.epub", title: "Test Book", author_id: READER_ID },
    ownsBookRpcResult = false,
  } = overrides;

  return {
    auth: {
      getUser: () =>
        Promise.resolve({
          data: { user: userId ? { id: userId, email: userEmail ?? undefined } : null },
        }),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => Promise.resolve({ data: book }),
        }),
      }),
    }),
    rpc: () => Promise.resolve({ data: ownsBookRpcResult }),
  };
}

function makeFakeAdminClient(overrides: { fileBytes?: Buffer; downloadError?: unknown } = {}) {
  const { fileBytes = Buffer.from("fake epub bytes"), downloadError = null } = overrides;
  const download = vi.fn(() =>
    Promise.resolve(
      downloadError
        ? { data: null, error: downloadError }
        : { data: new Blob([new Uint8Array(fileBytes)]), error: null },
    ),
  );
  return { storage: { from: () => ({ download }) }, __download: download };
}

function makeRequest() {
  return new Request(`https://librumal.vercel.app/api/books/${BOOK_ID}/download`);
}

describe("GET /api/books/[id]/download", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    recoveryActive = false;
    mockCreateClient.mockClear();
    mockCreateAdminClient.mockClear();
    mockWatermarkEpub.mockClear();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  describe("recovery-session defense-in-depth", () => {
    it("returns 403 and never reaches Supabase when a recovery session is active", async () => {
      recoveryActive = true;

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toMatch(/password/i);
      expect(mockCreateClient).not.toHaveBeenCalled();
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
      expect(mockWatermarkEpub).not.toHaveBeenCalled();
    });
  });

  describe("successful watermark", () => {
    it("serves the watermarked bytes with 200, and logs nothing", async () => {
      const fileBytes = Buffer.from("original epub bytes");
      const watermarkedBytes = Buffer.from("watermarked epub bytes");
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));
      mockWatermarkEpub.mockResolvedValue({ watermarked: true, bytes: watermarkedBytes });

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.equals(watermarkedBytes)).toBe(true);
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

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

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

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

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

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

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
      mockCreateClient.mockResolvedValue(makeFakeSupabase());
      mockCreateAdminClient.mockReturnValue(makeFakeAdminClient({ fileBytes }));
      mockWatermarkEpub.mockResolvedValue({
        watermarked: false,
        bytes: fileBytes,
        failureStage: "unsupported_structure",
      });

      await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

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
      expect(serialized).not.toContain("author-1/book-1.epub"); // storage path
    });
  });

  describe("entitlement failure", () => {
    it("redirects before ever downloading the manuscript or calling watermarkEpub", async () => {
      const adminClient = makeFakeAdminClient();
      mockCreateClient.mockResolvedValue(
        makeFakeSupabase({
          book: { file_path: "someone-else/book-1.epub", title: "Test Book", author_id: "someone-else" },
          ownsBookRpcResult: false,
        }),
      );
      mockCreateAdminClient.mockReturnValue(adminClient);

      const response = await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

      expect(response.status).toBe(307); // NextResponse.redirect default
      expect(mockWatermarkEpub).not.toHaveBeenCalled();
      expect(adminClient.__download).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(errorSpy).not.toHaveBeenCalled();
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

      await GET(makeRequest(), { params: Promise.resolve({ id: BOOK_ID }) });

      expect(warnSpy.mock.calls.length + errorSpy.mock.calls.length).toBe(1);
    });
  });
});
