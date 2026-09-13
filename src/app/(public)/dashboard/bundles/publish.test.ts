import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// FIX/bundle-payout-publication-gate: dedicated coverage for
// performBundlePublish() (the bundle equivalent of performPublish() in
// dashboard/books/publish.test.ts), exercised here only indirectly
// through publishBundle() since performBundlePublish() itself is
// deliberately not exported. Kept in its own file (separate from
// recovery-guard.test.ts, which is narrowly scoped to only the
// recovery-session guard) since this needs its own mock shape: a
// `.select().eq().eq().maybeSingle()` read chain and a
// `.update().eq().eq().select()` write chain, plus a "profiles" table
// neither of recovery-guard.test.ts's harness wires.

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
const mockBundleSelectResult = vi.fn();
const mockProfileSelectResult = vi.fn();
const mockMemberSelectResult = vi.fn();
const mockBundleUpdatePayload = vi.fn();
const mockBundleUpdateResult = vi.fn();

// Records the EXACT arguments performBundlePublish()'s membership read
// passes to `.select()`/`.eq()` on "bundle_books" -- proves the real
// query shape (columns + the bundle_id filter) rather than only that
// *some* query happened. Deliberately does NOT use `!inner` on the
// `books(...)` embed here (unlike bookBelongsToPublishedBundle()'s own
// `bundles!inner(status)` in books/actions.ts) -- this read needs EVERY
// membership row, valid or not, to compute totalMembers vs validMembers
// itself; an `!inner` filter would silently drop invalid rows server-
// side and make totalMembers under-count, defeating the whole check.
const mockMemberQueryColumns = vi.fn();
const mockMemberQueryFilters = vi.fn();

// A minimal Supabase query-builder double: `.eq()` returns itself (so any
// number of chained `.eq()` calls works, matching both the bundle read's
// two `.eq()` calls and the profile read's one), `.maybeSingle()`
// resolves the read chain via the given resolver, and `.select()`
// resolves the write chain the same way -- mirroring the real
// supabase-js query builder's shape closely enough for this file's
// purposes (see dashboard/books/publish.test.ts's own `makeChain` for
// the established convention this follows).
function makeReadChain(resolve: () => unknown) {
  const chain = {
    eq: () => chain,
    maybeSingle: () => Promise.resolve(resolve()),
  };
  return chain;
}

function makeWriteChain(resolve: () => unknown) {
  const chain = {
    eq: () => chain,
    select: () => Promise.resolve(resolve()),
  };
  return chain;
}

// PHASE-2C bundle-membership-integrity: the bundle_books membership read
// in performBundlePublish() is a single `.eq("bundle_id", ...)` chain
// with no trailing `.maybeSingle()`/`.select()` call -- it's awaited
// directly, exactly like this codebase's other plain array-returning
// reads (e.g. deleteBook()'s own purchases count query). So this chain
// must be thenable itself, resolving via the given resolver.
function makeMemberChain(resolve: () => unknown) {
  const chain = {
    eq: (column: string, value: unknown) => {
      mockMemberQueryFilters(column, value);
      return chain;
    },
    // `.returns<T[]>()` (performBundlePublish()'s own type-shape helper
    // on this query -- see BundleMembershipRow in actions.ts) is a
    // type-only annotation in the real supabase-js client: at runtime it
    // returns the same builder unchanged, never altering what resolves.
    returns: () => chain,
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve(resolve()).then(onFulfilled, onRejected),
  };
  return chain;
}

const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (table === "bundles") {
        return {
          select: () => makeReadChain(() => mockBundleSelectResult()),
          update: (payload: unknown) => {
            mockBundleUpdatePayload(payload);
            return makeWriteChain(() => mockBundleUpdateResult());
          },
        };
      }
      if (table === "profiles") {
        return { select: () => makeReadChain(() => mockProfileSelectResult()) };
      }
      if (table === "bundle_books") {
        return {
          select: (columns: string) => {
            mockMemberQueryColumns(columns);
            return makeMemberChain(() => mockMemberSelectResult());
          },
        };
      }
      throw new Error(`unexpected table in this focused test: ${table}`);
    },
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { publishBundle } = await import("./actions");

const USER_ID = "author-1";
const BUNDLE_ID = "bundle-1";

function bundleRow(overrides: Partial<{ price_cents: number }> = {}) {
  return { data: { price_cents: 0, ...overrides }, error: null };
}

// PHASE-2C: a single bundle_books row shape, joined to its book's
// author_id/status exactly as performBundlePublish()'s own
// `.select("book_id, books(author_id, status)")` returns it. Defaults to
// a fully valid member (owned by USER_ID, published) -- callers override
// only what makes a specific test's member invalid.
function memberRow(bookId: string, overrides: Partial<{ author_id: string; status: string | null }> = {}) {
  return {
    book_id: bookId,
    books: { author_id: USER_ID, status: "published", ...overrides },
  };
}

// Convenience for the common "N fully valid members" case used as the
// default across the pre-existing payout-gate tests, none of which are
// concerned with membership validity at all.
function validMemberRows(count: number) {
  return {
    data: Array.from({ length: count }, (_, i) => memberRow(`book-${i}`)),
    error: null,
  };
}

function resetMocks() {
  mockRedirect.mockClear();
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
  mockBundleSelectResult.mockReset().mockReturnValue(bundleRow());
  mockProfileSelectResult.mockReset().mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });
  mockMemberSelectResult.mockReset().mockReturnValue(validMemberRows(2));
  mockMemberQueryColumns.mockClear();
  mockMemberQueryFilters.mockClear();
  mockBundleUpdatePayload.mockClear();
  mockBundleUpdateResult.mockReset().mockReturnValue({ data: [{ id: BUNDLE_ID }], error: null });
  mockCookieStore.get.mockReset().mockImplementation(() => undefined);
  mockRevalidatePath.mockReset();
}

describe("publishBundle: payout-readiness gate", () => {
  beforeEach(resetMocks);

  it("paid bundle + payouts disabled: blocked, update never attempted", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_cents: 999 }));
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=Connect+your+payout+account+before+publishing",
    );
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("paid bundle + payouts enabled: published", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_cents: 999 }));
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: true }, error: null });

    await publishBundle(BUNDLE_ID); // no redirect on success -- must not throw

    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/bundles");
  });

  it("free bundle + payouts disabled: published, profiles table never queried", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_cents: 0 }));

    await publishBundle(BUNDLE_ID);

    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("bundle read error: fail closed, update never attempted", async () => {
    // A genuine query-execution failure -- distinct from the "not found"
    // case below, which returns {data: null, error: null} instead.
    mockBundleSelectResult.mockReturnValue({ data: null, error: { message: "connection reset" } });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/bundles");
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("profile read error: fail closed, update never attempted", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_cents: 999 }));
    mockProfileSelectResult.mockReturnValue({ data: null, error: { message: "connection reset" } });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/bundles");
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("unauthorized/missing bundle: blocked, update never attempted", async () => {
    // An ordinary zero-row result -- no such bundle, or not owned by
    // this author -- is {data: null, error: null}, never a database error.
    mockBundleSelectResult.mockReturnValue({ data: null, error: null });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/bundles");
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("final update error: failure reported, no successful outcome", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_cents: 0 }));
    mockBundleUpdateResult.mockReturnValue({ data: null, error: { message: "db exploded" } });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    // The update WAS attempted here -- it just failed. This is distinct
    // from the pre-mutation failure cases above, where the update must
    // never be attempted at all.
    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/bundles");
    const target = mockRedirect.mock.calls[0][0];
    expect(target).not.toContain("db exploded");
  });

  it("final update affects zero rows without a conventional database error: failure reported", async () => {
    // Proves the .select("id") row-count check itself: a well-formed,
    // error-free response that matched zero rows must still be treated
    // as a failure, never coerced into ok:true.
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_cents: 0 }));
    mockBundleUpdateResult.mockReturnValue({ data: [], error: null });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/bundles");
  });

  it("price_cents === 0 boundary: skips the payout check exactly at zero", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_cents: 0 }));
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });

    await publishBundle(BUNDLE_ID);

    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("price_cents === 1 boundary: requires payout readiness at the smallest positive price", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_cents: 1 }));
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=Connect+your+payout+account+before+publishing",
    );
  });

  it("requires authentication before touching anything", async () => {
    mockGetUser.mockReset().mockResolvedValue({ data: { user: null } });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/login");
    expect(mockBundleSelectResult).not.toHaveBeenCalled();
  });
});

describe("publishBundle: bundle-membership-integrity gate (PHASE-2C)", () => {
  beforeEach(resetMocks);

  it("exactly 2 valid members: published", async () => {
    mockMemberSelectResult.mockReturnValue(validMemberRows(2));

    await publishBundle(BUNDLE_ID);

    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("queries bundle_books->books(author_id, status) with the exact columns and filter, scoped to this bundle, unfiltered by validity", async () => {
    // Proves the actual PostgREST query shape performBundlePublish()
    // issues -- not just that some query happened. In particular, this
    // would catch a regression that added `!inner` (or any server-side
    // status/author filter) to the embed, which would silently drop
    // invalid rows before they ever reach the JS-side total-vs-valid
    // comparison and defeat this whole check.
    mockMemberSelectResult.mockReturnValue(validMemberRows(2));

    await publishBundle(BUNDLE_ID);

    expect(mockMemberQueryColumns).toHaveBeenCalledWith("book_id, books(author_id, status)");
    expect(mockMemberQueryFilters).toHaveBeenCalledWith("bundle_id", BUNDLE_ID);
  });

  it("3 valid members: published", async () => {
    mockMemberSelectResult.mockReturnValue(validMemberRows(3));

    await publishBundle(BUNDLE_ID);

    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("3 members with 1 unpublished: blocked even though 2 members remain valid", async () => {
    // Proves the total-vs-valid comparison, not a "filter then check >=2"
    // check: totalMembers=3, validMembers=2 -- these differ, so the WHOLE
    // bundle is rejected, not silently accepted as "a 2-book bundle."
    mockMemberSelectResult.mockReturnValue({
      data: [memberRow("book-0"), memberRow("book-1"), memberRow("book-2", { status: "draft" })],
      error: null,
    });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=This+bundle+needs+at+least+2+published+books",
    );
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("2 members with 1 unpublished: blocked", async () => {
    mockMemberSelectResult.mockReturnValue({
      data: [memberRow("book-0"), memberRow("book-1", { status: "draft" })],
      error: null,
    });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=This+bundle+needs+at+least+2+published+books",
    );
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("fewer than 2 members: blocked", async () => {
    mockMemberSelectResult.mockReturnValue(validMemberRows(1));

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=This+bundle+needs+at+least+2+published+books",
    );
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("zero members: blocked", async () => {
    mockMemberSelectResult.mockReturnValue({ data: [], error: null });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=This+bundle+needs+at+least+2+published+books",
    );
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("membership read error: fail closed, update never attempted", async () => {
    mockMemberSelectResult.mockReturnValue({ data: null, error: { message: "connection reset" } });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    // A genuine read failure falls into the generic "read_failed" branch
    // -- the SAME redirect target as a bundle/profile read failure above
    // -- never the more specific "insufficient_members" message, which
    // would misleadingly imply the membership was actually read and
    // found wanting.
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/bundles");
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("a member owned by a different author is invalid: blocked", async () => {
    mockMemberSelectResult.mockReturnValue({
      data: [memberRow("book-0"), memberRow("book-1", { author_id: "someone-else" })],
      error: null,
    });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=This+bundle+needs+at+least+2+published+books",
    );
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("a membership row with no joined book (deleted book) is invalid: blocked", async () => {
    mockMemberSelectResult.mockReturnValue({
      data: [memberRow("book-0"), { book_id: "book-1", books: null }],
      error: null,
    });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=This+bundle+needs+at+least+2+published+books",
    );
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });
});

describe("publishBundle: recovery-session defense-in-depth (existing protection, unchanged)", () => {
  beforeEach(resetMocks);

  it("redirects to /reset-password and never touches Supabase when a recovery session is active", async () => {
    mockCookieStore.get.mockImplementation((name: string) =>
      name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined,
    );

    await expect(publishBundle(BUNDLE_ID)).rejects.toMatchObject({
      target: expect.stringContaining("/reset-password"),
    });

    expect(mockBundleSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });
});
