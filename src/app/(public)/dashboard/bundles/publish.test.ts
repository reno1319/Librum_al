import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";
import { STAGING_SUPABASE_URL } from "@/lib/protected-staging";

// PR-G: dedicated coverage for
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
// ALL-WIRING-5: the exact column list performBundlePublish() asks the
// bundle read for, so a test can prove `price_cents` is not even
// fetched -- not merely that it happened to be ignored.
const mockBundleQueryColumns = vi.fn();

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
          select: (columns: string) => {
            mockBundleQueryColumns(columns);
            return makeReadChain(() => mockBundleSelectResult());
          },
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

// ALL-WIRING-5: the bundle row carries `price_all`, the only column the
// publish decision reads. A legacy `price_cents` is present on purpose
// and deliberately DISAGREES with it by default (legacy 2500 against an
// explicit free 0), so any test that passes because the wrong column was
// consulted would pass for the wrong reason visibly.
function bundleRow(
  overrides: Partial<{ price_all: number | null; price_cents: number }> = {},
) {
  return { data: { price_all: 0, price_cents: 2500, ...overrides }, error: null };
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
// default across the pre-existing publish-gate tests, none of which are
// concerned with membership validity at all.
function validMemberRows(count: number) {
  return {
    data: Array.from({ length: count }, (_, i) => memberRow(`book-${i}`)),
    error: null,
  };
}

// PAID-MODE-1: paid publishing requires the controlled-staging
// publishing permission (src/lib/paid-readiness.ts). Since PR-G that is
// the ONLY thing it requires. The permission is granted for every
// pre-existing test here -- otherwise they would silently become tests
// of that gate instead of their own subject -- and the gate's own
// coverage is the last describe block in THIS file.
function stubPaidPublishingAllowed() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "staging");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", STAGING_SUPABASE_URL);
  vi.stubEnv("PAID_PUBLISHING_MODE", "controlled_staging_publishing_test");
}

function resetMocks() {
  stubPaidPublishingAllowed();
  mockRedirect.mockClear();
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
  mockBundleSelectResult.mockReset().mockReturnValue(bundleRow());
  // PR-G: `profiles` is no longer read by performBundlePublish() at ANY
  // price. The mock is deliberately RETAINED, returning the row the
  // removed gate would have rejected, so every successful paid publish
  // below is also proof that nothing read it.
  mockProfileSelectResult.mockReset().mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });
  mockMemberSelectResult.mockReset().mockReturnValue(validMemberRows(2));
  mockMemberQueryColumns.mockClear();
  mockMemberQueryFilters.mockClear();
  mockBundleUpdatePayload.mockClear();
  mockBundleQueryColumns.mockClear();
  mockBundleUpdateResult.mockReset().mockReturnValue({ data: [{ id: BUNDLE_ID }], error: null });
  mockCookieStore.get.mockReset().mockImplementation(() => undefined);
  mockRevalidatePath.mockReset();
}

describe("publishBundle: paid-publishing readiness gate", () => {
  beforeEach(resetMocks);

  // PR-G: replaces the "paid bundle + payouts disabled: blocked" /
  // "+ payouts enabled: published" pair. The profile mock still reports
  // payouts disabled (see resetMocks), so publication succeeding IS the
  // proof the Stripe prerequisite is gone.
  it("paid bundle publishes with the capability allowed, reading no profile", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 999 }));

    await publishBundle(BUNDLE_ID); // no redirect on success -- must not throw

    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(mockRevalidatePath).toHaveBeenCalledWith("/dashboard/bundles");
  });

  it("paid bundle publishes when stripe_payouts_enabled is null, and when the profile row is missing entirely", async () => {
    for (const profileResult of [
      { data: { stripe_payouts_enabled: null }, error: null },
      { data: null, error: null },
    ]) {
      resetMocks();
      mockProfileSelectResult.mockReturnValue(profileResult);
      mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 999 }));

      await publishBundle(BUNDLE_ID);

      expect(mockProfileSelectResult).not.toHaveBeenCalled();
      expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    }
  });

  it("free bundle: published, profiles table never queried", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 0 }));

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

  // PR-G: the profile-read "read_failed" case is gone with the read
  // itself. "read_failed" is NOT gone from the result union -- the
  // bundle read above and the membership read below both still produce
  // it, and both keep their own coverage.
  it("a profile read failure is impossible now: a paid bundle publishes however profiles would have answered", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 999 }));
    mockProfileSelectResult.mockReturnValue({ data: null, error: { message: "connection reset" } });

    await publishBundle(BUNDLE_ID);

    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    expect(mockRedirect).not.toHaveBeenCalled();
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
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 0 }));
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
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 0 }));
    mockBundleUpdateResult.mockReturnValue({ data: [], error: null });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/bundles");
  });

  it("price_all === 0 boundary: skips the capability check exactly at zero", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 0 }));
    vi.stubEnv("PAID_PUBLISHING_MODE", "");

    await publishBundle(BUNDLE_ID);

    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("price_all === 99 boundary: requires the capability at the smallest paid price", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 99 }));
    vi.stubEnv("PAID_PUBLISHING_MODE", "");

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=Paid+publishing+isn%27t+available+right+now",
    );
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
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
    // -- the SAME redirect target as a bundle read failure above --
    // never the more specific "insufficient_members" message, which
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

afterEach(() => vi.unstubAllEnvs());

// PAID-MODE-1 / PR-G: the same paid-publishing permission at the bundle
// path, and since PR-G the sole gate. The load-bearing negative
// assertion now holds in EVERY case, allowed or denied: `profiles` is
// never read, and a denial never reaches the membership read either.
describe("performBundlePublish: paid-publishing mode gate (PAID-MODE-1)", () => {
  const PAID_PRICE = 1999;

  beforeEach(() => {
    resetMocks();
    vi.stubEnv("NEW_CHECKOUT_REGIME", "librum_ledger_v1");
    vi.stubEnv("LEDGER_PAYMENT_PROVIDER", "pok");
    vi.stubEnv("POK_ENVIRONMENT", "staging");
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: PAID_PRICE }));
    // Left at the value the REMOVED gate would have rejected, on purpose.
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });
    mockMemberSelectResult.mockReturnValue(validMemberRows(2));
  });

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["wrongly cased", "CONTROLLED_STAGING_PUBLISHING_TEST"],
    ["the checkout mode's value", "controlled_staging_checkout_test"],
    ["the superseded shared value", "controlled_staging_test"],
    ["production", "production"],
  ])("a %s publishing mode denies a paid bundle WITHOUT reading profiles", async (_label, value) => {
    vi.stubEnv("PAID_PUBLISHING_MODE", value as string);

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=Paid+publishing+isn%27t+available+right+now",
    );
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockMemberSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("denies in Production even with the mode set correctly", async () => {
    vi.stubEnv("VERCEL_ENV", "production");

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=Paid+publishing+isn%27t+available+right+now",
    );
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
  });

  // PR-G, the canonical proof, mirroring books/publish.test.ts: with the
  // capability ALLOWED, a paid bundle publishes and `profiles` is never
  // read. It replaced "the existing payout gate still blocks a paid
  // bundle" (removed behaviour) and its payouts-enabled twin.
  it("with the capability allowed, a paid bundle publishes and no profile is ever read", async () => {
    await publishBundle(BUNDLE_ID);

    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  // Removing the prerequisite did not bypass the capability.
  it("with the capability denied, a paid bundle stays unpublished however the payout flag reads", async () => {
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    mockProfileSelectResult.mockReturnValue({ data: { stripe_payouts_enabled: true }, error: null });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=Paid+publishing+isn%27t+available+right+now",
    );
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockMemberSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  // read_failed and insufficient_members keep their exact meanings: the
  // capability sits between the price fork and the membership read
  // without displacing either outcome.
  it("a failed bundle read still fails closed before the gate is even reached", async () => {
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    mockBundleSelectResult.mockReturnValue({ data: null, error: { message: "boom" } });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/dashboard/bundles");
    expect(mockProfileSelectResult).not.toHaveBeenCalled();
  });

  it("insufficient members is unaffected when the mode is allowed", async () => {
    mockMemberSelectResult.mockReturnValue({
      data: [memberRow("book-0"), memberRow("book-1", { status: "draft" })],
      error: null,
    });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=This+bundle+needs+at+least+2+published+books",
    );
  });

  it("a free bundle publishes with the mode variable unset, and reads no profile", async () => {
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 0 }));

    await publishBundle(BUNDLE_ID);

    expect(mockProfileSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).toHaveBeenCalledWith(
      expect.objectContaining({ status: "published" }),
    );
  });
});

// ALL-WIRING-5: the publish decision reads `bundles.price_all` and only
// `price_all`. Every fixture below that matters carries a legacy
// `price_cents` that would give the OPPOSITE answer if it were read.
describe("performBundlePublish: price_all three-way state (ALL-WIRING-5)", () => {
  const MISSING_PRICE_REDIRECT =
    `/dashboard/bundles/${BUNDLE_ID}/edit?error=` +
    encodeURIComponent("Set a valid ALL price before publishing this bundle.");
  const PAID_MODE_REDIRECT = "/dashboard/bundles?error=Paid+publishing+isn%27t+available+right+now";

  beforeEach(resetMocks);

  // PAID-REPRICING-1: `status` joins the read, because the publish write
  // is now a compare-and-set on the status and price it read. Still no
  // price_cents.
  it("reads exactly status and price_all from the owned bundle row -- price_cents is not even fetched", async () => {
    await publishBundle(BUNDLE_ID);

    expect(mockBundleQueryColumns).toHaveBeenCalledTimes(1);
    expect(mockBundleQueryColumns).toHaveBeenCalledWith("status, price_all");
    expect(String(mockBundleQueryColumns.mock.calls[0][0])).not.toContain("price_cents");
  });

  it("null price_all is refused before the membership read and before any update, even with paid mode allowed", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: null, price_cents: 0 }));

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(MISSING_PRICE_REDIRECT);
    expect(mockMemberSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("null price_all with a legacy price_cents of 2500 does not use the legacy value", async () => {
    // If price_cents were consulted this would be "paid", and with paid
    // mode allowed it would PUBLISH. It must instead be unavailable.
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: null, price_cents: 2500 }));

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(MISSING_PRICE_REDIRECT);
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("a MISSING price_all key is unavailable, never free -- even when price_cents is 0", async () => {
    // A projection that omitted the column must not read as free, which
    // is what `price_cents === 0` (or `!price_all`) would have said.
    vi.stubEnv("PAID_PUBLISHING_MODE", "");
    mockBundleSelectResult.mockReturnValue({ data: { price_cents: 0 }, error: null });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(MISSING_PRICE_REDIRECT);
    expect(mockMemberSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it.each([
    ["1 (below the paid floor)", 1],
    ["98 (below the paid floor)", 98],
    ["100001 (above the ceiling)", 100_001],
    ["a fraction", 199.5],
    ["a negative", -199],
    ["negative zero", -0],
    ["a numeric string", "199"],
  ])("an out-of-domain price_all of %s is unavailable, never paid or free", async (_label, value) => {
    mockBundleSelectResult.mockReturnValue({ data: { price_all: value, price_cents: 0 }, error: null });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(MISSING_PRICE_REDIRECT);
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("price_all 0 publishes with PAID_PUBLISHING_MODE entirely absent (legacy price_cents 2500 ignored)", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("PAID_PUBLISHING_MODE", undefined as unknown as string);
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 0, price_cents: 2500 }));

    await publishBundle(BUNDLE_ID);

    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("price_all 199 with price_cents 0 is PAID: denied while PAID_PUBLISHING_MODE is absent", async () => {
    // The mirror image: price_cents === 0 would have called this free
    // and published it with no permission at all.
    vi.unstubAllEnvs();
    vi.stubEnv("PAID_PUBLISHING_MODE", undefined as unknown as string);
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 199, price_cents: 0 }));

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(PAID_MODE_REDIRECT);
    expect(mockMemberSelectResult).not.toHaveBeenCalled();
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("price_all 199 with price_cents 0 publishes only once the paid-publishing capability allows it", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 199, price_cents: 0 }));

    await publishBundle(BUNDLE_ID);

    expect(mockBundleUpdatePayload).toHaveBeenCalledWith({ status: "published" });
  });

  it.each([
    ["the minimum", 99],
    ["the maximum", 100_000],
  ])("a paid price at %s is still denied with the paid mode absent", async (_label, priceAll) => {
    vi.unstubAllEnvs();
    vi.stubEnv("PAID_PUBLISHING_MODE", undefined as unknown as string);
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: priceAll, price_cents: 0 }));

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(PAID_MODE_REDIRECT);
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("a valid price does not bypass membership integrity: 3 members with 1 invalid is still refused", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: 0 }));
    mockMemberSelectResult.mockReturnValue({
      data: [memberRow("book-0"), memberRow("book-1"), { book_id: "book-2", books: null }],
      error: null,
    });

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      "/dashboard/bundles?error=This+bundle+needs+at+least+2+published+books",
    );
    expect(mockBundleUpdatePayload).not.toHaveBeenCalled();
  });

  it("the missing-price message names no environment variable and echoes no value", async () => {
    mockBundleSelectResult.mockReturnValue(bundleRow({ price_all: null, price_cents: 2500 }));

    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const target = decodeURIComponent(mockRedirect.mock.calls[0][0]);
    expect(target).not.toMatch(/PAID_|VERCEL|2500|\$|USD/);
  });
});
