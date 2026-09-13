import { describe, expect, it, vi, beforeEach } from "vitest";

// PHASE-2C bundle-membership-integrity: dedicated coverage for
// unpublishBook() and deleteBook()'s new published-bundle-membership
// protection (bookBelongsToPublishedBundle(), shared by both -- see its
// own comment in actions.ts). Kept in its own file (separate from
// publish.test.ts, which is scoped to createBook()/publishBook() and
// wires a different, incompatible mock table set) since this needs its
// own "purchases" and "bundle_books" table mocks neither of
// publish.test.ts's harness supports.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => mockRevalidatePath(path) }));

const mockCookieStore = {
  get: vi.fn((_name: string) => undefined as { value: string } | undefined),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockGetUser = vi.fn();
const mockBookSelectResult = vi.fn();
const mockMemberSelectResult = vi.fn();
const mockBookUpdatePayload = vi.fn();
const mockBookUpdateResult = vi.fn();
const mockPurchaseCountResult = vi.fn();
const mockBookDeleteResult = vi.fn();
const mockRemove = vi.fn();

// Records the EXACT arguments bookBelongsToPublishedBundle() (actions.ts)
// passes to `.select()`/`.eq()` on the "bundle_books" table -- unlike the
// generic makeChain() below (used for "books"/"purchases", whose exact
// filter arguments this file doesn't need to assert), these are captured
// so a test can prove the real PostgREST query shape (columns + both
// filters, including the joined-table dot-path filter that makes the
// `bundles!inner(status)` embed actually filter server-side) rather than
// only asserting that *some* query happened, which would pass even if
// the embed or filter path were silently wrong.
const mockMemberQueryColumns = vi.fn();
const mockMemberQueryFilters = vi.fn();

// `.eq()` returns itself (any number of chained calls), `.maybeSingle()`/
// `.single()` resolve via the given resolver, `.select()` resolves the
// write chain the same way, and the chain is itself thenable so a plain
// `await builder.select(...).eq(...)` (no trailing terminal call --
// exactly how bookBelongsToPublishedBundle()'s and the purchases-count
// query's own reads are written) also resolves via the same resolver.
// Mirrors the established convention in dashboard/books/publish.test.ts
// and dashboard/bundles/publish.test.ts.
function makeChain(resolve: () => unknown) {
  const chain = {
    eq: () => chain,
    single: () => Promise.resolve(resolve()),
    maybeSingle: () => Promise.resolve(resolve()),
    select: () => makeChain(resolve),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };
  return chain;
}

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (table === "books") {
        return {
          select: () => makeChain(() => mockBookSelectResult()),
          update: (payload: unknown) => {
            mockBookUpdatePayload(payload);
            return makeChain(() => mockBookUpdateResult());
          },
          delete: () => makeChain(() => mockBookDeleteResult()),
        };
      }
      if (table === "bundle_books") {
        return {
          select: (columns: string) => {
            mockMemberQueryColumns(columns);
            const chain = {
              eq: (column: string, value: unknown) => {
                mockMemberQueryFilters(column, value);
                return chain;
              },
              then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
                Promise.resolve(mockMemberSelectResult()).then(onFulfilled, onRejected),
            };
            return chain;
          },
        };
      }
      if (table === "purchases") {
        return { select: () => makeChain(() => mockPurchaseCountResult()) };
      }
      throw new Error(`unexpected table in this focused test: ${table}`);
    },
    storage: {
      from: () => ({ remove: mockRemove }),
    },
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { unpublishBook, deleteBook } = await import("./actions");

const USER_ID = "author-1";
const BOOK_ID = "book-1";

function notInAnyPublishedBundle() {
  return { data: [], error: null };
}

function inAPublishedBundle() {
  return { data: [{ bundle_id: "bundle-1", bundles: { status: "published" } }], error: null };
}

function resetMocks() {
  mockRedirect.mockClear();
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
  mockBookSelectResult.mockReset().mockReturnValue({ data: { id: BOOK_ID, cover_path: null, file_path: null }, error: null });
  mockMemberSelectResult.mockReset().mockReturnValue(notInAnyPublishedBundle());
  mockMemberQueryColumns.mockClear();
  mockMemberQueryFilters.mockClear();
  mockBookUpdatePayload.mockClear();
  mockBookUpdateResult.mockReset().mockReturnValue({ data: [{ id: BOOK_ID }], error: null });
  mockPurchaseCountResult.mockReset().mockReturnValue({ count: 0, error: null });
  mockBookDeleteResult.mockReset().mockReturnValue({ error: null });
  mockRemove.mockReset().mockResolvedValue({ error: null });
  mockCookieStore.get.mockReset().mockImplementation(() => undefined);
  mockRevalidatePath.mockReset();
}

describe("unpublishBook: published-bundle-membership gate (PHASE-2C)", () => {
  beforeEach(resetMocks);

  it("book referenced only by draft/no bundles: unpublishes successfully", async () => {
    mockMemberSelectResult.mockReturnValue(notInAnyPublishedBundle());

    await unpublishBook(BOOK_ID);

    expect(mockBookUpdatePayload).toHaveBeenCalledWith({ status: "draft" });
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard");
    expect(mockRevalidatePath).toHaveBeenCalledWith("/");
  });

  it("book is a member of a currently published bundle: blocked, update never attempted", async () => {
    mockMemberSelectResult.mockReturnValue(inAPublishedBundle());

    await expect(unpublishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const target = mockRedirect.mock.calls[0][0] as string;
    expect(target).toContain("/dashboard?error=");
    expect(target).toContain("published+bundle");
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  });

  it("membership read error: fails closed, book remains published, update never attempted", async () => {
    mockMemberSelectResult.mockReturnValue({ data: null, error: { message: "connection reset" } });

    await expect(unpublishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  });

  it("book read error before membership check: fails closed, membership never queried", async () => {
    mockBookSelectResult.mockReturnValue({ data: null, error: { message: "connection reset" } });

    await expect(unpublishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockMemberSelectResult).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  });

  it("unowned/missing book: redirected, membership never queried, update never attempted", async () => {
    mockBookSelectResult.mockReturnValue({ data: null, error: null });

    await expect(unpublishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockMemberSelectResult).not.toHaveBeenCalled();
    expect(mockBookUpdatePayload).not.toHaveBeenCalled();
  });

  it("update database failure: reported as a failure, never presented as success", async () => {
    mockBookUpdateResult.mockReturnValue({ data: null, error: { message: "db exploded" } });

    await expect(unpublishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBookUpdatePayload).toHaveBeenCalledWith({ status: "draft" });
    const target = mockRedirect.mock.calls[0][0] as string;
    expect(target).not.toContain("db exploded");
  });

  it("update affects zero rows without a conventional error: reported as a failure", async () => {
    mockBookUpdateResult.mockReturnValue({ data: [], error: null });

    await expect(unpublishBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBookUpdatePayload).toHaveBeenCalledWith({ status: "draft" });
  });

  it("queries bundle_books->bundles(status) with the exact columns and filters, scoped to this book and published only", async () => {
    // Proves the actual PostgREST query shape bookBelongsToPublishedBundle()
    // issues -- not just that some query happened. A regression that
    // dropped `!inner`, filtered on the wrong (un-joined) column, or
    // scoped to the wrong book_id would fail THIS assertion even though
    // every other test in this file only cares about the resolved data.
    mockMemberSelectResult.mockReturnValue(notInAnyPublishedBundle());

    await unpublishBook(BOOK_ID);

    expect(mockMemberQueryColumns).toHaveBeenCalledWith("bundle_id, bundles!inner(status)");
    expect(mockMemberQueryFilters).toHaveBeenCalledWith("book_id", BOOK_ID);
    expect(mockMemberQueryFilters).toHaveBeenCalledWith("bundles.status", "published");
  });
});

describe("deleteBook: published-bundle-membership gate (PHASE-2C)", () => {
  beforeEach(resetMocks);

  it("book referenced only by draft/no bundles, never purchased: deletes successfully", async () => {
    mockMemberSelectResult.mockReturnValue(notInAnyPublishedBundle());

    await deleteBook(BOOK_ID);

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("never-purchased book that's a member of a published bundle: blocked, delete never attempted", async () => {
    mockMemberSelectResult.mockReturnValue(inAPublishedBundle());

    await expect(deleteBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const target = mockRedirect.mock.calls[0][0] as string;
    expect(target).toContain("/dashboard?error=");
    expect(target).toContain("published+bundle");
    expect(mockPurchaseCountResult).not.toHaveBeenCalled();
  });

  it("published-bundle block uses a distinct message from the purchases block", async () => {
    mockMemberSelectResult.mockReturnValue(inAPublishedBundle());
    mockPurchaseCountResult.mockReturnValue({ count: 5, error: null });

    await expect(deleteBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const target = mockRedirect.mock.calls[0][0] as string;
    expect(target).not.toContain("acquired+by+readers");
  });

  it("membership read error: fails closed, delete never attempted", async () => {
    mockMemberSelectResult.mockReturnValue({ data: null, error: { message: "connection reset" } });

    await expect(deleteBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockPurchaseCountResult).not.toHaveBeenCalled();
  });

  it("existing purchase-based deletion protection remains intact for a book in no bundle", async () => {
    mockMemberSelectResult.mockReturnValue(notInAnyPublishedBundle());
    mockPurchaseCountResult.mockReturnValue({ count: 1, error: null });

    await expect(deleteBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard?error=This+book+has+been+acquired+by+readers+and+can%27t+be+deleted+-+unpublish+it+instead",
    );
  });

  it("delete database failure: reported as a failure, never presented as success", async () => {
    mockMemberSelectResult.mockReturnValue(notInAnyPublishedBundle());
    mockBookDeleteResult.mockReturnValue({ error: { code: "XXXXX", message: "db exploded" } });

    await expect(deleteBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard?error=Could+not+delete+that+book+right+now");
  });

  it("unowned/missing book: redirected, membership never queried", async () => {
    mockBookSelectResult.mockReturnValue({ data: null, error: null });

    await expect(deleteBook(BOOK_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard");
    expect(mockMemberSelectResult).not.toHaveBeenCalled();
  });

  it("queries bundle_books->bundles(status) with the exact columns and filters, scoped to this book and published only", async () => {
    mockMemberSelectResult.mockReturnValue(notInAnyPublishedBundle());

    await deleteBook(BOOK_ID);

    expect(mockMemberQueryColumns).toHaveBeenCalledWith("bundle_id, bundles!inner(status)");
    expect(mockMemberQueryFilters).toHaveBeenCalledWith("book_id", BOOK_ID);
    expect(mockMemberQueryFilters).toHaveBeenCalledWith("bundles.status", "published");
  });
});
