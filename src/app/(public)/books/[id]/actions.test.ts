import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
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
  getStripe: () => ({
    checkout: { sessions: { create: mockCheckoutSessionsCreate } },
    accounts: { retrieve: (...args: unknown[]) => mockAccountsRetrieve(...args) },
  }),
}));

const mockPokConfig = vi.fn();
const mockPokClient = vi.fn();
const mockPokRepository = vi.fn();
const mockStartPok = vi.fn();
vi.mock("@/lib/pok", () => ({ getPokConfig: () => mockPokConfig(), createPokClient: () => mockPokClient() }));
vi.mock("@/lib/pok-checkout", () => ({
  startPokCheckout: (...args: unknown[]) => mockStartPok(...args),
  POK_CHECKOUT_CANNOT_RESUME: "POK_CHECKOUT_CANNOT_RESUME",
}));
vi.mock("@/lib/pok-repository", () => ({ createPokRepository: () => mockPokRepository() }));
const { buyBook, getFreeBook } = await import("./actions");

describe("buyBook: POK provider selection", () => {
  const rpc = vi.fn();
  beforeEach(() => {
    vi.stubEnv("NEW_CHECKOUT_REGIME", "librum_ledger_v1"); vi.stubEnv("LEDGER_PAYMENT_PROVIDER", "pok");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    mockCookieStore.get.mockImplementation(() => undefined);
    mockRedirect.mockClear(); mockCheckoutSessionsCreate.mockClear(); mockAccountsRetrieve.mockClear();
    mockPokConfig.mockReset().mockReturnValue({ merchantId: "merchant", keyId: "key", keySecret: "secret" });
    mockPokClient.mockReturnValue({}); mockPokRepository.mockReturnValue({});
    mockStartPok.mockReset().mockResolvedValue("https://pay-staging.pokpay.io/sdk-orders/test");
    rpc.mockReset().mockImplementation(async (name: string) => name === "user_owns_book"
      ? { data: false } : { data: [{ intent_id: "intent", price_cents_at_checkout: 499, expires_at: "2026-09-15T10:30:00Z" }] });
    mockCreateClient.mockResolvedValue({ auth: { getUser: async () => ({ data: { user: { id: "reader" } } }) }, rpc,
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: "book", title: "Test", price_cents: 499, author_id: "author", status: "published", profiles: null } }) }) }) }) });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("starts POK with a frozen ALL intent and no Stripe key/account dependency", async () => {
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({ target: "https://pay-staging.pokpay.io/sdk-orders/test" });
    expect(rpc).toHaveBeenCalledWith("create_book_checkout_intent", expect.objectContaining({ p_regime: "librum_ledger_v1", p_currency: "ALL" }));
    expect(mockStartPok).toHaveBeenCalled(); expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled(); expect(mockAccountsRetrieve).not.toHaveBeenCalled();
  });
  it("POK failure never falls back to Stripe", async () => {
    mockStartPok.mockRejectedValue(new Error("timeout"));
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({ target: "/books/book?error=Could+not+start+checkout" });
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
  it("an unsafe-to-resume checkout gets an honest message, never the generic one", async () => {
    mockStartPok.mockRejectedValue(new Error("POK_CHECKOUT_CANNOT_RESUME"));
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({
      target: "/books/book?error=We%20can't%20safely%20reopen%20this%20checkout.%20If%20you%20already%20paid%2C%20check%20your%20library%3B%20otherwise%2C%20please%20contact%20support%20to%20complete%20this%20purchase.",
    });
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
  it("invalid sandbox configuration fails before an intent is minted", async () => {
    mockPokConfig.mockImplementation(() => { throw new Error("POK_STAGING_ONLY"); });
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({ target: "/books/book?error=Could+not+start+checkout" });
    expect(rpc).not.toHaveBeenCalled(); expect(mockStartPok).not.toHaveBeenCalled(); expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
});

describe("buyBook: recovery-session defense-in-depth", () => {
  beforeEach(() => {
    mockCookieStore.get.mockImplementation((name: string) => name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined);
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

// STRIPE-DISABLE-1: the legacy Stripe Connect checkout branch this file
// used to cover here (LIBRUM 2.0 CONNECT-HARDEN-1's connected-account
// gate) and the ledger_v1-without-POK Stripe fallback branch (STRIPE-
// CUTOVER-2A Section 32) have both been REMOVED from buyBook, per the
// locked product decision that no configuration may create a new Stripe
// buyer checkout any more. The tests that used to live in this file for
// those two branches asserted the exact fail-OPEN-to-Stripe behavior
// this patch removes, so they are superseded, not weakened -- replaced
// below by an exhaustive fail-closed matrix over the same input space.
// This is the one deliberate, explicit exception to "don't rewrite an
// existing expectation that conflicts with the locked decision" the
// task called for: these particular pre-existing expectations directly
// encoded the fail-open behavior being removed, so preserving them
// unmodified would assert the opposite of this patch's own goal.
//
// The buyBook: POK provider selection and buyBook: recovery-session
// defense-in-depth describe blocks above are untouched -- their
// behavior and assertions are unaffected by this patch.
describe("buyBook: fail-closed provider resolution (STRIPE-DISABLE-1)", () => {
  const BOOK_ID = "book-1";
  const READER_ID = "reader-1";
  const AUTHOR_ID = "author-1";
  const UNAVAILABLE_PREFIX = `/books/${BOOK_ID}?error=`;
  const ORIGINAL_REGIME = process.env.NEW_CHECKOUT_REGIME;
  const ORIGINAL_PROVIDER = process.env.LEDGER_PAYMENT_PROVIDER;

  function makeBookRow() {
    return {
      id: BOOK_ID,
      title: "Test Book",
      price_cents: 999,
      status: "published",
      author_id: AUTHOR_ID,
    };
  }

  let mockBookSingle = vi.fn();
  let mockRpc = vi.fn();

  beforeEach(() => {
    mockRedirect.mockClear();
    mockAccountsRetrieve.mockReset();
    mockCheckoutSessionsCreate.mockReset();
    mockCreateAdminClient.mockReset();
    mockPokConfig.mockReset();
    mockPokClient.mockReset();
    mockPokRepository.mockReset();
    mockStartPok.mockReset();
    mockCookieStore.get.mockImplementation(() => undefined);

    mockBookSingle = vi.fn().mockResolvedValue({ data: makeBookRow(), error: null });
    mockRpc = vi.fn().mockResolvedValue({ data: null, error: null });
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: READER_ID } } }) },
      from: (table: string) => {
        if (table !== "books") {
          throw new Error(`buyBook fail-closed tests: unexpected table "${table}"`);
        }
        return { select: () => ({ eq: () => ({ single: () => mockBookSingle() }) }) };
      },
      rpc: (...args: unknown[]) => mockRpc(...args),
    });
  });

  afterEach(() => {
    if (ORIGINAL_REGIME === undefined) delete process.env.NEW_CHECKOUT_REGIME;
    else process.env.NEW_CHECKOUT_REGIME = ORIGINAL_REGIME;
    if (ORIGINAL_PROVIDER === undefined) delete process.env.LEDGER_PAYMENT_PROVIDER;
    else process.env.LEDGER_PAYMENT_PROVIDER = ORIGINAL_PROVIDER;
  });

  // Every one of these is a configuration that used to reach Stripe
  // (either the legacy default/explicit branch, or the ledger-regime
  // Stripe fallback) before this patch. None of them may reach any
  // provider, any RPC, or any DB write now.
  const nonExactConfigs: Array<[string, string | undefined, string | undefined]> = [
    ["both env vars unset (pre-cutover default)", undefined, undefined],
    ["both env vars empty", "", ""],
    ["legacy regime explicit, provider unset", "legacy_stripe_connect_v1", undefined],
    ["legacy regime explicit, provider pok", "legacy_stripe_connect_v1", "pok"],
    ["ledger regime, provider unset", "librum_ledger_v1", undefined],
    ["ledger regime, provider empty", "librum_ledger_v1", ""],
    ["ledger regime, provider explicitly stripe", "librum_ledger_v1", "stripe"],
    ["ledger regime, provider wrong case", "librum_ledger_v1", "POK"],
    ["ledger regime, provider with leading space", "librum_ledger_v1", " pok"],
    ["regime wrong case, provider pok", "LIBRUM_LEDGER_V1", "pok"],
    ["regime with leading space, provider pok", " librum_ledger_v1", "pok"],
    ["unrecognized regime, provider pok", "not_a_real_regime", "pok"],
  ];

  it.each(nonExactConfigs)(
    "%s: fails closed before any RPC, POK, Stripe, or DB call",
    async (_label, regime, provider) => {
      delete process.env.NEW_CHECKOUT_REGIME;
      delete process.env.LEDGER_PAYMENT_PROVIDER;
      if (regime !== undefined) process.env.NEW_CHECKOUT_REGIME = regime;
      if (provider !== undefined) process.env.LEDGER_PAYMENT_PROVIDER = provider;

      await expect(buyBook(BOOK_ID, new FormData())).rejects.toMatchObject({
        target: expect.stringContaining(UNAVAILABLE_PREFIX),
      });

      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockPokConfig).not.toHaveBeenCalled();
      expect(mockStartPok).not.toHaveBeenCalled();
      expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
      expect(mockAccountsRetrieve).not.toHaveBeenCalled();
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
    },
  );

  it("the disabled-checkout redirect never contains internal config values", async () => {
    delete process.env.NEW_CHECKOUT_REGIME;
    delete process.env.LEDGER_PAYMENT_PROVIDER;

    await expect(buyBook(BOOK_ID, new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedUrl = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedUrl).not.toContain("legacy_stripe_connect_v1");
    expect(redirectedUrl).not.toContain("librum_ledger_v1");
    expect(redirectedUrl).not.toContain("stripe_account");
  });
});

// STRIPE-DISABLE-1: getFreeBook is unmodified by this patch -- these are
// its first tests, added to prove the required regression guarantee that
// free-book acquisition remains available and completely provider-free
// (never touches Stripe, POK, or any Stripe/POK checkout-intent RPC)
// after the paid-checkout disablement above.
describe("getFreeBook: provider-free acquisition remains available (STRIPE-DISABLE-1 regression)", () => {
  const BOOK_ID = "book-1";
  const READER_ID = "reader-1";
  const AUTHOR_ID = "author-1";

  let mockBookSingle = vi.fn();
  let mockRpc = vi.fn();
  let mockPurchasesUpsert = vi.fn();

  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateAdminClient.mockReset();
    mockCheckoutSessionsCreate.mockReset();
    mockAccountsRetrieve.mockReset();
    mockPokConfig.mockReset();
    mockStartPok.mockReset();

    mockBookSingle = vi.fn().mockResolvedValue({
      data: { id: BOOK_ID, price_cents: 0, status: "published", author_id: AUTHOR_ID },
      error: null,
    });
    mockRpc = vi.fn().mockResolvedValue({ data: false, error: null });
    mockPurchasesUpsert = vi.fn().mockResolvedValue({ error: null });

    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: READER_ID } } }) },
      from: (table: string) => {
        if (table !== "books") {
          throw new Error(`getFreeBook tests: unexpected table "${table}"`);
        }
        return { select: () => ({ eq: () => ({ single: () => mockBookSingle() }) }) };
      },
      rpc: (...args: unknown[]) => mockRpc(...args),
    });
    mockCreateAdminClient.mockReturnValue({
      from: (table: string) => {
        if (table !== "purchases") {
          throw new Error(`getFreeBook tests: unexpected admin table "${table}"`);
        }
        return { upsert: (...args: unknown[]) => mockPurchasesUpsert(...args) };
      },
    });
  });

  it("succeeds for a free, unowned book without touching Stripe, POK, or any checkout-intent RPC", async () => {
    await expect(getFreeBook(BOOK_ID)).rejects.toMatchObject({ target: `/books/${BOOK_ID}?free=success` });

    expect(mockPurchasesUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ book_id: BOOK_ID, reader_id: READER_ID, amount_cents: 0 }),
      expect.anything(),
    );
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    expect(mockAccountsRetrieve).not.toHaveBeenCalled();
    expect(mockPokConfig).not.toHaveBeenCalled();
    expect(mockStartPok).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalledWith("create_book_checkout_intent", expect.anything());
  });

  it("already-owned free book: idempotent no-op redirect, never re-upserts", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });

    await expect(getFreeBook(BOOK_ID)).rejects.toMatchObject({ target: `/books/${BOOK_ID}?free=success` });

    expect(mockPurchasesUpsert).not.toHaveBeenCalled();
  });

  it("a priced (non-free) book is refused, regardless of the checkout-provider configuration", async () => {
    mockBookSingle.mockResolvedValue({
      data: { id: BOOK_ID, price_cents: 999, status: "published", author_id: AUTHOR_ID },
      error: null,
    });

    await expect(getFreeBook(BOOK_ID)).rejects.toMatchObject({ target: `/books/${BOOK_ID}` });

    expect(mockPurchasesUpsert).not.toHaveBeenCalled();
  });
});
