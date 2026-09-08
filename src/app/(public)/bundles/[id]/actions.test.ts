import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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

// STRIPE-CUTOVER-2A Section 33: buyBundle's librum_ledger_v1 branch --
// mirrors buyBook's own ledger_v1 coverage.
describe("buyBundle: librum_ledger_v1 regime (STRIPE-CUTOVER-2A)", () => {
  const BUNDLE_ID = "bundle-1";
  const READER_ID = "reader-1";
  const AUTHOR_ID = "author-1";
  const ORIGINAL_REGIME = process.env.NEW_CHECKOUT_REGIME;
  const ORIGINAL_KEY = process.env.STRIPE_SECRET_KEY;

  function makeLedgerBundleRow() {
    return {
      id: BUNDLE_ID,
      status: "published",
      author_id: AUTHOR_ID,
      // No stripe_account_id at all -- proves the ledger_v1 branch never
      // requires one.
      profiles: null,
    };
  }

  let mockBundleSingle = vi.fn();
  let mockBundleBooksSelect = vi.fn();
  let mockRpc = vi.fn();
  let mockSnapshotUpdateSelect = vi.fn();

  beforeEach(() => {
    mockRedirect.mockClear();
    mockAccountsRetrieve.mockReset();
    mockCheckoutSessionsCreate.mockReset();
    mockCreateAdminClient.mockReset();
    mockCookieStore.get.mockImplementation(() => undefined);
    process.env.NEW_CHECKOUT_REGIME = "librum_ledger_v1";
    process.env.STRIPE_SECRET_KEY = "sk_test_abc123";

    mockBundleSingle = vi.fn().mockResolvedValue({ data: makeLedgerBundleRow(), error: null });
    mockBundleBooksSelect = vi.fn().mockResolvedValue({
      data: [{ book_id: "book-a" }, { book_id: "book-b" }],
      error: null,
    });
    mockRpc = vi.fn().mockImplementation((name: string) => {
      if (name === "user_owns_book") return Promise.resolve({ data: false, error: null });
      if (name === "create_bundle_checkout_snapshot") {
        return Promise.resolve({
          data: [
            {
              snapshot_id: "snapshot-ledger-1",
              bundle_title: "Test Bundle",
              bundle_price_cents_at_checkout: 250000,
              protection_expires_at: "2026-08-24T09:00:00.000Z",
            },
          ],
          error: null,
        });
      }
      throw new Error(`unexpected rpc "${name}"`);
    });
    mockSnapshotUpdateSelect = vi.fn().mockResolvedValue({ data: [{ id: "snapshot-ledger-1" }], error: null });
    mockCreateAdminClient.mockReturnValue({
      from: (table: string) => {
        if (table !== "bundle_checkout_snapshots") {
          throw new Error(`ledger buyBundle test: unexpected admin table "${table}"`);
        }
        return {
          update: () => ({ eq: () => ({ is: () => ({ select: mockSnapshotUpdateSelect }) }) }),
        };
      },
    });
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: READER_ID } } }) },
      from: (table: string) => {
        if (table === "bundles") {
          return { select: () => ({ eq: () => ({ single: () => mockBundleSingle() }) }) };
        }
        if (table === "bundle_books") {
          return { select: () => ({ eq: () => mockBundleBooksSelect() }) };
        }
        throw new Error(`ledger buyBundle test: unexpected table "${table}"`);
      },
      rpc: (...args: unknown[]) => mockRpc(...(args as [string, unknown])),
    });
  });

  afterEach(() => {
    if (ORIGINAL_REGIME === undefined) delete process.env.NEW_CHECKOUT_REGIME;
    else process.env.NEW_CHECKOUT_REGIME = ORIGINAL_REGIME;
    if (ORIGINAL_KEY === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = ORIGINAL_KEY;
  });

  it("never calls the Connect account gate for a ledger_v1 bundle checkout", async () => {
    mockCheckoutSessionsCreate.mockResolvedValue({
      id: "cs_ledger_1",
      url: "https://checkout.stripe.com/cs_ledger_1",
    });

    await expect(buyBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockAccountsRetrieve).not.toHaveBeenCalled();
  });

  it("freezes regime=librum_ledger_v1, currency=ALL, and the current royalty rate on create_bundle_checkout_snapshot", async () => {
    mockCheckoutSessionsCreate.mockResolvedValue({
      id: "cs_ledger_1",
      url: "https://checkout.stripe.com/cs_ledger_1",
    });

    await expect(buyBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRpc).toHaveBeenCalledWith("create_bundle_checkout_snapshot", {
      bundle_id: BUNDLE_ID,
      p_regime: "librum_ledger_v1",
      p_currency: "ALL",
      p_royalty_rate_bps: 8000,
    });
  });

  it("creates a Stripe session with currency 'all', unit_amount in minor units, and no Connect fields", async () => {
    mockCheckoutSessionsCreate.mockResolvedValue({
      id: "cs_ledger_1",
      url: "https://checkout.stripe.com/cs_ledger_1",
    });

    await expect(buyBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockCheckoutSessionsCreate).toHaveBeenCalledTimes(1);
    const [params] = mockCheckoutSessionsCreate.mock.calls[0] as [
      { line_items: { price_data: { currency: string; unit_amount: number } }[]; payment_intent_data?: unknown },
    ];
    expect(params.line_items[0].price_data.currency).toBe("all");
    expect(params.line_items[0].price_data.unit_amount).toBe(250000);
    expect(params.payment_intent_data).toBeUndefined();
  });

  it("fails closed and never reaches the checkout-snapshot RPC when STRIPE_SECRET_KEY is not a test key", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_abc123";
    vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(buyBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(`/bundles/${BUNDLE_ID}?error=`));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
});
