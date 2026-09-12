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
const mockBundleUpdatePayload = vi.fn();
const mockBundleUpdateResult = vi.fn();

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

function resetMocks() {
  mockRedirect.mockClear();
  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID } } });
  mockBundleSelectResult.mockReset().mockReturnValue(bundleRow());
  mockProfileSelectResult.mockReset().mockReturnValue({ data: { stripe_payouts_enabled: false }, error: null });
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
