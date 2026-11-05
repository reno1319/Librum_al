import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// The maintenance-mode gate of every book action that is left, against a
// focused Supabase double. BD15 cleanup: the createBook/updateBook/
// publishBook tests this file held went with those actions; the file
// checks they made of shared code now drive saveBookContent
// (book-storage-mutation-authorization.test.ts) and saveBookPricing
// (pricing-send.test.ts).

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
// ADMIN-3-REVIEW: book_reviews reads/writes replaced by a settable
// double (default: nothing pending, approval valid); see
// src/lib/book-reviews-test-double.ts.
vi.mock("@/lib/book-reviews", async (importOriginal) => {
  const { bookReviewsDouble } = await import("@/lib/book-reviews-test-double");
  return bookReviewsDouble(await importOriginal<object>());
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// ALL-CUTOVER APP-A: unpublishBook/deleteBook call this AFTER their own
// maintenance gate -- mocked (not left real) so the maintenance-mode
// gate tests below can assert it's never reached, the same way
// mockCreateClient already proves no Supabase call happens.
const mockRedirectIfRecoverySessionActive = vi.fn();
vi.mock("@/lib/recovery-guard", () => ({
  redirectIfRecoverySessionActive: mockRedirectIfRecoverySessionActive,
}));

const mockGetUser = vi.fn();
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockExistingSingle = vi.fn();
const mockUploadCover = vi.fn();
const mockUploadManuscript = vi.fn();
// LIBRUM 2.0 PRODUCT-5 CB-1: the manuscripts bucket now also needs
// download() (resolveManuscriptInput() downloading a temp EPUB
// reference) and remove() (cleaning it up after a successful save).
const mockDownloadManuscript = vi.fn();
const mockRemoveManuscript = vi.fn();

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      // ADMIN-3-REVIEW (C): a new file or cover on a LIVE book first
      // checks published-bundle membership; none here.
      if (table === "bundle_books") {
        const none = { data: [], error: null };
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise.resolve(none).then(f, r),
        };
        return chain;
      }
      if (table !== "books") {
        throw new Error(`unexpected table in this focused test: ${table}`);
      }
      return {
        // CATALOG-STORAGE-PATH-AUTH-1: createBook's insert now runs through
        // the trusted writer and proves its one new row with `.select("id")`,
        // so the double returns the inserted id.
        insert: (payload: unknown) => {
          mockInsert(payload);
          return {
            select: () =>
              Promise.resolve({ data: [{ id: (payload as { id: string }).id }], error: null }),
          };
        },
        // PEN-2: updateBook's ownership read filters by id AND author_id.
        select: () => {
          const read = { eq: () => read, single: () => mockExistingSingle() };
          return read;
        },
        // PAID-REPRICING-1: updateBook's write is now guarded and proved
        // by its returned rows, so the double supports `.is()` and ends
        // in `.select()`, reporting the one row it changed.
        update: (payload: unknown) => {
          mockUpdate(payload);
          const chain = {
            eq: () => chain,
            is: () => chain,
            select: () => Promise.resolve({ data: [{ id: BOOK_ID }], error: null }),
          };
          return chain;
        },
      };
    },
    storage: {
      from: (bucket: string) => {
        if (bucket === "covers") {
          // PEN-2 (L10): a replaced cover is removed after the write.
          return { upload: mockUploadCover, remove: async () => ({ data: [], error: null }) };
        }
        if (bucket === "manuscripts") {
          return {
            upload: mockUploadManuscript,
            download: mockDownloadManuscript,
            remove: mockRemoveManuscript,
          };
        }
        throw new Error(`unexpected bucket in this focused test: ${bucket}`);
      },
    },
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
// CATALOG-WRITE-AUTH-1: the protected catalog writes go through
// createCatalogWriteClient(). This focused suite routes that client onto
// the same session double so its payload and filter assertions still see
// every write; WHICH client performs which write is pinned separately in
// dashboard/catalog-write-authorization.test.ts.
// PEN-NAMES-1: the pen name box resolves through the server-only pen
// name writer; here it always resolves to the author's default.
vi.mock("@/lib/pen-name-write-client", () => ({
  resolveOwnPenNameId: async () => ({ ok: true, penNameId: "f0000000-0000-4000-8000-00000000pen0" }),
}));
vi.mock("@/lib/catalog-write-client", async () => {
  const { catalogWriterReplayingOnto } = await import("@/lib/catalog-write-test-double");
  return { createCatalogWriteClient: () => catalogWriterReplayingOnto(() => mockCreateClient()) };
});


const { saveBookContent, saveBookPricing, unpublishBook, deleteBook } = await import("./actions");

const USER_ID = "a1b2c3d4-1111-4111-8111-abcdef111111";
const BOOK_ID = "c3d4e5f6-2222-4222-8222-abcdef222222";

function resetMocks() {
  mockRedirect.mockClear();
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
  mockInsert.mockClear();
  mockUpdate.mockClear();
  mockExistingSingle.mockReset().mockResolvedValue({
    data: {
      id: BOOK_ID,
      cover_path: `${USER_ID}/${BOOK_ID}-cover.png`,
      file_path: `${USER_ID}/${BOOK_ID}.epub`,
      author_id: USER_ID,
      language: null,
      status: "published",
      price_all: 0,
    },
  });
  mockUploadCover.mockReset().mockResolvedValue({ error: null });
  mockUploadManuscript.mockReset().mockResolvedValue({ error: null });
  mockDownloadManuscript.mockReset().mockResolvedValue({
    data: null,
    error: { message: "not found" },
  });
  mockRemoveManuscript.mockReset().mockResolvedValue({ error: null });
}

// APP A CORRECTION 2: every book action that writes catalog price or
// bundle-membership-relevant state is gated before any Supabase call.
describe("saveBookContent/saveBookPricing/unpublishBook/deleteBook: maintenance-mode gate", () => {
  beforeEach(() => {
    resetMocks();
    mockCreateClient.mockClear();
    mockRedirectIfRecoverySessionActive.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["saveBookContent", () => saveBookContent(BOOK_ID, new FormData())],
    ["saveBookPricing", () => saveBookPricing(BOOK_ID, new FormData())],
  ])("%s redirects to the editor with the maintenance message and never reaches Supabase", async (_name, action) => {
    await expect(action()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(`/dashboard/books/${BOOK_ID}/editor?error=`));
    expect(mockRedirectIfRecoverySessionActive).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("unpublishBook redirects with the maintenance message before the recovery-session check or any Supabase call", async () => {
    await expect(unpublishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/dashboard?error="));
    expect(mockRedirectIfRecoverySessionActive).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("deleteBook redirects with the maintenance message before the recovery-session check or any Supabase call", async () => {
    await expect(deleteBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/dashboard?error="));
    expect(mockRedirectIfRecoverySessionActive).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) lets the action reach its own session check", async () => {
    vi.unstubAllEnvs();
    mockGetUser.mockReset().mockResolvedValue({ data: { user: null } });
    await expect(saveBookContent(BOOK_ID, new FormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockCreateClient).toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalledWith(expect.stringContaining("error="));
  });
});
