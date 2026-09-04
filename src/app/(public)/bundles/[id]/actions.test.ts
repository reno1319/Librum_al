import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// LAUNCH-1 P1-11: minimal, focused coverage of ONLY the new recovery
// guard added to buyBundle -- see the equivalent buyBook test
// (src/app/books/[id]/actions.test.ts) for the full rationale.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const mockCookieStore = {
  get: vi.fn((name: string) => (name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined)),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));
const mockCheckoutSessionsCreate = vi.fn();
const mockAccountsRetrieve = vi.fn();
vi.mock("@/lib/stripe", () => ({
  stripe: {
    checkout: { sessions: { create: mockCheckoutSessionsCreate } },
    accounts: { retrieve: (...args: unknown[]) => mockAccountsRetrieve(...args) },
  },
}));

const { buyBundle } = await import("./actions");

describe("buyBundle: recovery-session defense-in-depth", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    mockCreateAdminClient.mockClear();
    mockCheckoutSessionsCreate.mockClear();
  });

  it("redirects to /reset-password and never reaches Supabase or Stripe when a recovery session is active", async () => {
    await expect(buyBundle("bundle-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
});

// LIBRUM 2.0 CONNECT-HARDEN-1: covers buyBundle's connected-account
// validation gate -- the bundle-side equivalent of buyBook's own gate
// (src/app/books/[id]/actions.test.ts), same production incident, same
// fix. Scoped narrowly to the gate itself.
describe("buyBundle: connected-account validation gate (LIBRUM 2.0 CONNECT-HARDEN-1)", () => {
  const BUNDLE_ID = "bundle-1";
  const READER_ID = "reader-1";
  const AUTHOR_ID = "author-1";
  const UNAVAILABLE_PREFIX = `/bundles/${BUNDLE_ID}?error=`;

  function makeBundleRow(
    profileOverrides: Partial<{ stripe_account_id: string | null; stripe_payouts_enabled: boolean }> = {},
  ) {
    return {
      id: BUNDLE_ID,
      status: "published",
      author_id: AUTHOR_ID,
      profiles: { stripe_account_id: null, stripe_payouts_enabled: false, ...profileOverrides },
    };
  }

  let mockBundleSingle = vi.fn();
  let mockBundleBooksSelect = vi.fn();

  beforeEach(() => {
    mockRedirect.mockClear();
    mockAccountsRetrieve.mockReset();
    mockCheckoutSessionsCreate.mockReset();
    mockCreateAdminClient.mockClear();
    mockCookieStore.get.mockImplementation(() => undefined);

    mockBundleSingle = vi.fn();
    mockBundleBooksSelect = vi.fn().mockResolvedValue({ data: [], error: null });
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: READER_ID } } }) },
      from: (table: string) => {
        if (table === "bundles") {
          return { select: () => ({ eq: () => ({ single: () => mockBundleSingle() }) }) };
        }
        if (table === "bundle_books") {
          return { select: () => ({ eq: () => mockBundleBooksSelect() }) };
        }
        throw new Error(`buyBundle gate tests: unexpected table "${table}"`);
      },
      rpc: () => Promise.resolve({ data: null, error: null }),
    });
  });

  it("no stripe_account_id on file: rejects before any Stripe account lookup or membership check", async () => {
    mockBundleSingle.mockResolvedValue({ data: makeBundleRow({ stripe_account_id: null }), error: null });

    await expect(buyBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(UNAVAILABLE_PREFIX));
    expect(mockAccountsRetrieve).not.toHaveBeenCalled();
    expect(mockBundleBooksSelect).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it("Stripe resource_missing (stale/wrong-platform/test-mode account): rejects with the generic message, real reason logged server-side only", async () => {
    mockBundleSingle.mockResolvedValue({
      data: makeBundleRow({ stripe_account_id: "acct_stale" }),
      error: null,
    });
    const stripeError = Object.assign(new Error("No such destination: 'acct_stale'"), {
      code: "resource_missing",
    });
    mockAccountsRetrieve.mockRejectedValue(stripeError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(buyBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(UNAVAILABLE_PREFIX));
    expect(mockBundleBooksSelect).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not ready for checkout"),
      expect.objectContaining({ reason: "missing" }),
    );
    errorSpy.mockRestore();
  });

  it("connected account retrieved but payouts_enabled is false: rejects with the generic message", async () => {
    mockBundleSingle.mockResolvedValue({
      data: makeBundleRow({ stripe_account_id: "acct_pending" }),
      error: null,
    });
    mockAccountsRetrieve.mockResolvedValue({
      id: "acct_pending",
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      capabilities: { transfers: "active" },
    });

    await expect(buyBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(UNAVAILABLE_PREFIX));
    expect(mockBundleBooksSelect).not.toHaveBeenCalled();
  });

  it("connected account retrieved but capabilities.transfers is not active: rejects with the generic message", async () => {
    mockBundleSingle.mockResolvedValue({
      data: makeBundleRow({ stripe_account_id: "acct_pending" }),
      error: null,
    });
    mockAccountsRetrieve.mockResolvedValue({
      id: "acct_pending",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      capabilities: { transfers: "inactive" },
    });

    await expect(buyBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(UNAVAILABLE_PREFIX));
    expect(mockBundleBooksSelect).not.toHaveBeenCalled();
  });

  // LIBRUM 2.0 CONNECT-HARDEN-1 REVIEW CORRECTION regression: proves the
  // removed charges_enabled dependency stays removed for bundles too.
  it("connected account has charges_enabled=false but payouts_enabled + transfers=active: gate PASSES", async () => {
    mockBundleSingle.mockResolvedValue({
      data: makeBundleRow({ stripe_account_id: "acct_ready" }),
      error: null,
    });
    mockAccountsRetrieve.mockResolvedValue({
      id: "acct_ready",
      charges_enabled: false,
      payouts_enabled: true,
      details_submitted: true,
      capabilities: { transfers: "active" },
    });
    mockBundleBooksSelect.mockResolvedValue({ data: [], error: null });

    await expect(buyBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(`/bundles/${BUNDLE_ID}`);
  });

  it("valid, fully payout-ready account: passes the gate and proceeds past it", async () => {
    mockBundleSingle.mockResolvedValue({
      data: makeBundleRow({ stripe_account_id: "acct_ready" }),
      error: null,
    });
    mockAccountsRetrieve.mockResolvedValue({
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      capabilities: { transfers: "active" },
    });
    // Empty membership triggers buyBundle's own PRE-EXISTING empty-bundle
    // redirect (a different target, with no ?error=) -- only proves the
    // gate let execution continue, not a re-test of buyBundle's
    // membership logic itself.
    mockBundleBooksSelect.mockResolvedValue({ data: [], error: null });

    await expect(buyBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockAccountsRetrieve).toHaveBeenCalledWith("acct_ready");
    expect(mockBundleBooksSelect).toHaveBeenCalled();
    expect(mockRedirect).toHaveBeenCalledWith(`/bundles/${BUNDLE_ID}`);
  });

  it("buyer-facing redirect never contains the Stripe account id or internal Stripe error text", async () => {
    mockBundleSingle.mockResolvedValue({
      data: makeBundleRow({ stripe_account_id: "acct_1U4LsoIwnWBEg0IB" }),
      error: null,
    });
    const stripeError = Object.assign(
      new Error(
        "No such destination: 'acct_1U4LsoIwnWBEg0IB'; a similar object exists in test mode, but a live mode key was used to make this request.",
      ),
      { code: "resource_missing" },
    );
    mockAccountsRetrieve.mockRejectedValue(stripeError);
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(buyBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedUrl = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedUrl).not.toContain("acct_");
    expect(redirectedUrl).not.toContain("test mode");
    expect(redirectedUrl).not.toContain("live mode key");
  });
});
