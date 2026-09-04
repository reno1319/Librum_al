import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// LAUNCH-1 P1-11: minimal, focused coverage of ONLY the new recovery
// guard added to buyBook -- not a re-test of buyBook's own pre-existing
// checkout logic (that stays untouched and uncovered here, per the
// audit's own instruction not to expand this into a rewrite of every
// authenticated action). Mocks every dependency the guard's own early
// return must prevent from ever being reached.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

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

const { buyBook } = await import("./actions");

describe("buyBook: recovery-session defense-in-depth", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    mockCreateAdminClient.mockClear();
    mockCheckoutSessionsCreate.mockClear();
  });

  it("redirects to /reset-password and never reaches Supabase or Stripe when a recovery session is active", async () => {
    await expect(buyBook("book-1", new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
});

// LIBRUM 2.0 CONNECT-HARDEN-1: covers buyBook's connected-account
// validation gate -- the direct fix for the production incident where a
// stale/wrong-platform/test-mode profiles.stripe_account_id was passed
// straight into payment_intent_data.transfer_data.destination, producing
// an opaque Stripe "No such destination" error at checkout time. Scoped
// narrowly to the gate itself (does it block, does it pass, does it leak
// nothing to the reader) -- not a re-test of buyBook's own pre-existing
// checkout-intent/Stripe-session logic beyond it.
describe("buyBook: connected-account validation gate (LIBRUM 2.0 CONNECT-HARDEN-1)", () => {
  const BOOK_ID = "book-1";
  const READER_ID = "reader-1";
  const AUTHOR_ID = "author-1";
  const UNAVAILABLE_PREFIX = `/books/${BOOK_ID}?error=`;

  function makeBookRow(
    profileOverrides: Partial<{ stripe_account_id: string | null; stripe_payouts_enabled: boolean }> = {},
  ) {
    return {
      id: BOOK_ID,
      title: "Test Book",
      price_cents: 999,
      status: "published",
      author_id: AUTHOR_ID,
      profiles: { stripe_account_id: null, stripe_payouts_enabled: false, ...profileOverrides },
    };
  }

  let mockBookSingle = vi.fn();
  let mockRpc = vi.fn();

  beforeEach(() => {
    mockRedirect.mockClear();
    mockAccountsRetrieve.mockReset();
    mockCheckoutSessionsCreate.mockReset();
    mockCreateAdminClient.mockClear();
    // Recovery guard must be a no-op for these tests -- they exist to
    // reach the connected-account gate, which sits well past it.
    mockCookieStore.get.mockImplementation(() => undefined);

    mockBookSingle = vi.fn();
    mockRpc = vi.fn().mockResolvedValue({ data: null, error: null });
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: READER_ID } } }) },
      from: (table: string) => {
        if (table !== "books") {
          throw new Error(`buyBook gate tests: unexpected table "${table}"`);
        }
        return { select: () => ({ eq: () => ({ single: () => mockBookSingle() }) }) };
      },
      rpc: (...args: unknown[]) => mockRpc(...args),
    });
  });

  it("no stripe_account_id on file: rejects before any Stripe account lookup or checkout intent", async () => {
    mockBookSingle.mockResolvedValue({ data: makeBookRow({ stripe_account_id: null }), error: null });

    await expect(buyBook(BOOK_ID, new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(UNAVAILABLE_PREFIX));
    expect(mockAccountsRetrieve).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it("Stripe resource_missing (stale/wrong-platform/test-mode account): rejects with the generic message, real reason logged server-side only", async () => {
    mockBookSingle.mockResolvedValue({
      data: makeBookRow({ stripe_account_id: "acct_stale" }),
      error: null,
    });
    const stripeError = Object.assign(new Error("No such destination: 'acct_stale'"), {
      code: "resource_missing",
    });
    mockAccountsRetrieve.mockRejectedValue(stripeError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(buyBook(BOOK_ID, new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(UNAVAILABLE_PREFIX));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("not ready for checkout"),
      expect.objectContaining({ reason: "missing" }),
    );
    errorSpy.mockRestore();
  });

  it("connected account retrieved but payouts_enabled is false: rejects with the generic message", async () => {
    mockBookSingle.mockResolvedValue({
      data: makeBookRow({ stripe_account_id: "acct_pending" }),
      error: null,
    });
    mockAccountsRetrieve.mockResolvedValue({
      id: "acct_pending",
      charges_enabled: true,
      payouts_enabled: false,
      details_submitted: true,
      capabilities: { transfers: "active" },
    });

    await expect(buyBook(BOOK_ID, new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(UNAVAILABLE_PREFIX));
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("connected account retrieved but capabilities.transfers is not active: rejects with the generic message", async () => {
    mockBookSingle.mockResolvedValue({
      data: makeBookRow({ stripe_account_id: "acct_pending" }),
      error: null,
    });
    mockAccountsRetrieve.mockResolvedValue({
      id: "acct_pending",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      capabilities: { transfers: "pending" },
    });

    await expect(buyBook(BOOK_ID, new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(UNAVAILABLE_PREFIX));
  });

  // LIBRUM 2.0 CONNECT-HARDEN-1 REVIEW CORRECTION regression: proves the
  // removed charges_enabled dependency stays removed at this integration
  // level too -- Librum never creates a charge on the connected account,
  // only a transfer, so charges_enabled=false must NOT block a sale.
  it("connected account has charges_enabled=false but payouts_enabled + transfers=active: gate PASSES", async () => {
    mockBookSingle.mockResolvedValue({
      data: makeBookRow({ stripe_account_id: "acct_ready" }),
      error: null,
    });
    mockAccountsRetrieve.mockResolvedValue({
      id: "acct_ready",
      charges_enabled: false,
      payouts_enabled: true,
      details_submitted: true,
      capabilities: { transfers: "active" },
    });
    mockRpc.mockResolvedValue({ data: true, error: null });

    await expect(buyBook(BOOK_ID, new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(`/books/${BOOK_ID}`);
  });

  it("valid, fully payout-ready account: passes the gate and proceeds past it", async () => {
    mockBookSingle.mockResolvedValue({
      data: makeBookRow({ stripe_account_id: "acct_ready" }),
      error: null,
    });
    mockAccountsRetrieve.mockResolvedValue({
      id: "acct_ready",
      charges_enabled: true,
      payouts_enabled: true,
      details_submitted: true,
      capabilities: { transfers: "active" },
    });
    // user_owns_book -> true triggers buyBook's own PRE-EXISTING
    // "already owns it" redirect (a different target, with no ?error=),
    // which only proves the gate let execution continue -- not a
    // re-test of buyBook's ownership logic itself.
    mockRpc.mockResolvedValue({ data: true, error: null });

    await expect(buyBook(BOOK_ID, new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockAccountsRetrieve).toHaveBeenCalledWith("acct_ready");
    expect(mockRpc).toHaveBeenCalledWith("user_owns_book", expect.anything());
    expect(mockRedirect).toHaveBeenCalledWith(`/books/${BOOK_ID}`);
  });

  it("buyer-facing redirect never contains the Stripe account id or internal Stripe error text", async () => {
    mockBookSingle.mockResolvedValue({
      data: makeBookRow({ stripe_account_id: "acct_1U4LsoIwnWBEg0IB" }),
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

    await expect(buyBook(BOOK_ID, new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedUrl = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedUrl).not.toContain("acct_");
    expect(redirectedUrl).not.toContain("test mode");
    expect(redirectedUrl).not.toContain("live mode key");
  });
});
