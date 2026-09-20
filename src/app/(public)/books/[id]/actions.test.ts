import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";
import { STAGING_SUPABASE_URL } from "@/lib/protected-staging";
import { BOOK_CHECKOUT_UNAVAILABLE_MESSAGE } from "@/lib/connect-account";

// PAID-MODE-1: buyBook now requires a paid-checkout permission as well
// as a provider. Every pre-existing test below that expects buyBook to
// REACH a provider therefore has to stub the protected staging
// deployment and the checkout mode -- otherwise it would be re-testing
// the new gate instead of its own subject. Nothing else about those
// tests changes.
function stubPaidCheckoutAllowed() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "staging");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", STAGING_SUPABASE_URL);
  vi.stubEnv("PAID_CHECKOUT_MODE", "controlled_staging_checkout_test");
}

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
const mockProbe = vi.fn();
// STALE-CHECKOUT-1: startPokCheckout returns a RESULT now, not a bare
// URL -- a completed order found while resuming has to be able to say
// "this is paid" instead of handing back a second payable link.
const CHECKOUT_URL = "https://pay-staging.pokpay.io/sdk-orders/test";
const checkoutUrlResult = { kind: "checkout_url", url: CHECKOUT_URL };
// Every quote the RPC returns now carries its own status. A row without
// one is malformed, and buyBook fails closed on it by design, so the
// fixtures state it explicitly rather than relying on a default.
function mintedQuote(priceCents: number, intentId = "intent") {
  return [{ intent_id: intentId, price_cents_at_checkout: priceCents, discount_code_id: null,
    expires_at: "2026-09-15T10:30:00Z", quote_status: "minted" }];
}
vi.mock("@/lib/pok", () => ({ getPokConfig: () => mockPokConfig(), createPokClient: () => mockPokClient() }));
vi.mock("@/lib/pok-checkout", () => ({
  startPokCheckout: (...args: unknown[]) => mockStartPok(...args),
  probeProviderAttempt: (...args: unknown[]) => mockProbe(...args),
  POK_CHECKOUT_CANNOT_RESUME: "POK_CHECKOUT_CANNOT_RESUME",
  POK_CHECKOUT_MAINTENANCE_ACTIVE: "POK_CHECKOUT_MAINTENANCE_ACTIVE",
  POK_CHECKOUT_IN_PROGRESS: "POK_CHECKOUT_IN_PROGRESS",
  POK_CHECKOUT_AMBIGUOUS: "POK_CHECKOUT_AMBIGUOUS",
  POK_CHECKOUT_ATTEMPT_RETIRED: "POK_CHECKOUT_ATTEMPT_RETIRED",
}));
vi.mock("@/lib/pok-repository", () => ({ createPokRepository: () => mockPokRepository() }));
const { buyBook, getFreeBook } = await import("./actions");

describe("buyBook: POK provider selection", () => {
  const rpc = vi.fn();
  beforeEach(() => {
    vi.stubEnv("NEW_CHECKOUT_REGIME", "librum_ledger_v1"); vi.stubEnv("LEDGER_PAYMENT_PROVIDER", "pok");
    vi.stubEnv("STRIPE_SECRET_KEY", ""); stubPaidCheckoutAllowed();
    mockCookieStore.get.mockImplementation(() => undefined);
    mockRedirect.mockClear(); mockCheckoutSessionsCreate.mockClear(); mockAccountsRetrieve.mockClear();
    mockPokConfig.mockReset().mockReturnValue({ merchantId: "merchant", keyId: "key", keySecret: "secret" });
    mockPokClient.mockReturnValue({}); mockPokRepository.mockReturnValue({});
    mockStartPok.mockReset().mockResolvedValue(checkoutUrlResult);
    mockProbe.mockReset();
    rpc.mockReset().mockImplementation(async (name: string) => name === "user_owns_book"
      ? { data: false } : { data: mintedQuote(499) });
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
  // APP A CORRECTION 2: startPokCheckout()'s own defense-in-depth
  // maintenance sentinel maps back to the exact same deterministic
  // redirect target buyBook()'s own top-of-function gate already
  // produces -- proving the two layers are never observably different.
  it("startPokCheckout's own maintenance sentinel redirects identically to the top-of-function gate", async () => {
    mockStartPok.mockRejectedValue(new Error("POK_CHECKOUT_MAINTENANCE_ACTIVE"));
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({
      target: "/books/book?error=Librum%20is%20temporarily%20unavailable%20for%20scheduled%20maintenance.%20Please%20try%20again%20shortly.",
    });
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
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

// ALL-CUTOVER APP-A: buyBook/getFreeBook are both mutable checkout/
// purchase ingress -- gated before any Supabase call, exactly like the
// recovery-session guard above.
describe("buyBook / getFreeBook: maintenance-mode gate", () => {
  beforeEach(() => {
    mockCookieStore.get.mockImplementation(() => undefined);
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    mockCreateAdminClient.mockClear();
    mockCheckoutSessionsCreate.mockClear();
    mockStartPok.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("buyBook redirects with the maintenance message and never reaches Supabase or POK", async () => {
    await expect(buyBook("book-1", new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining("/books/book-1?error="),
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockStartPok).not.toHaveBeenCalled();
  });

  it("getFreeBook redirects with the maintenance message and never reaches Supabase", async () => {
    await expect(getFreeBook("book-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining("/books/book-1?error="),
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves buyBook's existing allowed behavior", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("NEW_CHECKOUT_REGIME", "librum_ledger_v1");
    vi.stubEnv("LEDGER_PAYMENT_PROVIDER", "pok");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    stubPaidCheckoutAllowed();
    const rpc = vi.fn().mockImplementation(async (name: string) =>
      name === "user_owns_book"
        ? { data: false }
        : { data: mintedQuote(499) },
    );
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "reader" } } }) },
      rpc,
      from: () => ({
        select: () => ({
          eq: () => ({
            single: async () => ({
              data: { id: "book", title: "Test", price_cents: 499, author_id: "author", status: "published" },
            }),
          }),
        }),
      }),
    });
    mockPokConfig.mockReturnValue({ merchantId: "merchant", keyId: "key", keySecret: "secret" });
    mockStartPok.mockResolvedValue(checkoutUrlResult);

    await expect(buyBook("book", new FormData())).rejects.toMatchObject({
      target: "https://pay-staging.pokpay.io/sdk-orders/test",
    });
    expect(mockCreateClient).toHaveBeenCalled();
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
    // Paid checkout is PERMITTED throughout this block, so every case
    // below still proves what it always proved: that provider
    // resolution itself is what fails closed.
    stubPaidCheckoutAllowed();

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
    vi.unstubAllEnvs();
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

// PAID-MODE-1: the new paid-checkout permission, proved at the one live
// call site. The point of every case here is WHERE the denial happens:
// before provider resolution, before getPokConfig(), before any RPC and
// before any checkout-intent row exists.
describe("buyBook: paid-checkout mode gate (PAID-MODE-1)", () => {
  const BOOK_ID = "book-1";
  const READER_ID = "reader-1";
  const AUTHOR_ID = "author-1";

  let mockRpc = vi.fn();

  function arrangeConfiguredProvider() {
    // A COMPLETELY configured payment provider, so every denial below
    // proves the gate denied it, not a missing provider.
    vi.stubEnv("NEW_CHECKOUT_REGIME", "librum_ledger_v1");
    vi.stubEnv("LEDGER_PAYMENT_PROVIDER", "pok");
    vi.stubEnv("POK_ENVIRONMENT", "staging");
    vi.stubEnv("POK_MERCHANT_ID", "22222222-2222-4222-8222-222222222222");
    vi.stubEnv("POK_KEY_ID", "sdk-key-id");
    vi.stubEnv("POK_KEY_SECRET", "test-only");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_GIT_COMMIT_REF", "staging");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", STAGING_SUPABASE_URL);
  }

  beforeEach(() => {
    mockRedirect.mockClear();
    mockCookieStore.get.mockImplementation(() => undefined);
    mockPokConfig.mockReset().mockReturnValue({ merchantId: "m", keyId: "k", keySecret: "s" });
    mockPokClient.mockReset().mockReturnValue({});
    mockPokRepository.mockReset().mockReturnValue({});
    mockStartPok.mockReset().mockResolvedValue(checkoutUrlResult);
    mockProbe.mockReset();
    mockCheckoutSessionsCreate.mockReset();
    mockAccountsRetrieve.mockReset();
    mockRpc = vi.fn().mockResolvedValue({ data: false, error: null });
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: READER_ID } } }) },
      from: (table: string) => {
        if (table !== "books") throw new Error(`paid-mode tests: unexpected table "${table}"`);
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({
                  data: { id: BOOK_ID, title: "T", price_cents: 999, status: "published", author_id: AUTHOR_ID },
                  error: null,
                }),
            }),
          }),
        };
      },
      rpc: (...args: unknown[]) => mockRpc(...args),
    });
    arrangeConfiguredProvider();
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["absent", undefined],
    ["empty", ""],
    ["wrongly cased", "CONTROLLED_STAGING_CHECKOUT_TEST"],
    ["whitespace padded", " controlled_staging_checkout_test"],
    ["the publishing mode's value", "controlled_staging_publishing_test"],
    ["the superseded shared value", "controlled_staging_test"],
    ["production", "production"],
  ])(
    "a %s checkout mode denies before getPokConfig, any RPC and any provider call",
    async (_label, value) => {
      if (value !== undefined) vi.stubEnv("PAID_CHECKOUT_MODE", value);

      await expect(buyBook(BOOK_ID, new FormData())).rejects.toMatchObject({
        target: `/books/${BOOK_ID}?error=${encodeURIComponent(BOOK_CHECKOUT_UNAVAILABLE_MESSAGE)}`,
      });

      expect(mockPokConfig).not.toHaveBeenCalled();
      expect(mockStartPok).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
      expect(mockAccountsRetrieve).not.toHaveBeenCalled();
    },
  );

  it("denies in Production even with the mode set and the provider fully configured", async () => {
    vi.stubEnv("PAID_CHECKOUT_MODE", "controlled_staging_checkout_test");
    vi.stubEnv("VERCEL_ENV", "production");

    await expect(buyBook(BOOK_ID, new FormData())).rejects.toMatchObject({
      target: `/books/${BOOK_ID}?error=${encodeURIComponent(BOOK_CHECKOUT_UNAVAILABLE_MESSAGE)}`,
    });
    expect(mockPokConfig).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("the denial reveals nothing about the environment or the configuration", async () => {
    await expect(buyBook(BOOK_ID, new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedUrl = mockRedirect.mock.calls[0][0] as string;
    for (const leak of [
      "PAID_CHECKOUT_MODE",
      "controlled_staging",
      "preview",
      "staging",
      "librum_ledger_v1",
      "pok",
    ]) {
      expect(redirectedUrl).not.toContain(leak);
    }
  });

  // Maintenance stays FIRST and stronger: with both conditions active
  // the reader sees the maintenance message, and learns nothing about
  // the deployment's paid-mode state.
  it("maintenance mode wins over the paid-mode denial", async () => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");

    await expect(buyBook(BOOK_ID, new FormData())).rejects.toMatchObject({
      target: expect.stringContaining("maintenance"),
    });
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockPokConfig).not.toHaveBeenCalled();
  });

  it("the exact mode on the exact protected staging deployment still reaches POK", async () => {
    vi.stubEnv("PAID_CHECKOUT_MODE", "controlled_staging_checkout_test");
    mockRpc = vi.fn().mockImplementation(async (name: string) =>
      name === "user_owns_book"
        ? { data: false }
        : { data: mintedQuote(999) },
    );

    await expect(buyBook(BOOK_ID, new FormData())).rejects.toMatchObject({
      target: "https://pay-staging.pokpay.io/sdk-orders/test",
    });
    expect(mockStartPok).toHaveBeenCalled();
  });
});

// ============================================================
// STALE-CHECKOUT-1: buyBook's quote-status handling.
//
// The repair's whole premise is that create_book_checkout_intent now
// answers with a STATUS, not just a row, and that every one of those
// statuses has a distinct, honest reader-visible outcome. A status
// falling through to the generic "Could not start checkout" would hide
// exactly the lockout this work exists to remove, so each is asserted
// by its exact redirect target.
// ============================================================
describe("buyBook: stale-checkout quote statuses", () => {
  const READER = "reader";
  const INTENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let rpc: ReturnType<typeof vi.fn>;
  let quoteRows: unknown[];

  function msg(text: string) {
    return `/books/book?error=${encodeURIComponent(text)}`;
  }

  beforeEach(() => {
    vi.stubEnv("NEW_CHECKOUT_REGIME", "librum_ledger_v1");
    vi.stubEnv("LEDGER_PAYMENT_PROVIDER", "pok");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    stubPaidCheckoutAllowed();
    mockCookieStore.get.mockImplementation(() => undefined);
    mockRedirect.mockClear();
    mockPokConfig.mockReset().mockReturnValue({ merchantId: "merchant", keyId: "k", keySecret: "s" });
    mockPokClient.mockReset().mockReturnValue({});
    mockPokRepository.mockReset().mockReturnValue({});
    mockStartPok.mockReset().mockResolvedValue(checkoutUrlResult);
    mockProbe.mockReset();
    quoteRows = mintedQuote(499, INTENT);
    rpc = vi.fn().mockImplementation(async (name: string) =>
      name === "user_owns_book" ? { data: false } : { data: quoteRows });
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: READER } } }) },
      rpc,
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({
        data: { id: "book", title: "Test", price_cents: 499, author_id: "author", status: "published", profiles: null },
      }) }) }) }),
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  function quote(status: string, extra: Record<string, unknown> = {}) {
    quoteRows = [{ intent_id: INTENT, price_cents_at_checkout: 499, discount_code_id: null,
      expires_at: "2026-09-15T10:30:00Z", quote_status: status, ...extra }];
  }

  it.each([
    ["blocked_legacy_attempt", "An earlier checkout for this book must finish or expire before you can start a new one."],
    ["supersession_rate_limited", "Too many checkout attempts for this book. Please try again later."],
  ])("maps the %s status to its own honest message, never the generic one", async (status, text) => {
    quote(status);
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({ target: msg(text) });
    expect(mockStartPok).not.toHaveBeenCalled();
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it("reuses an eligible quote without minting a replacement", async () => {
    quote("reused");
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({ target: CHECKOUT_URL });
    expect(rpc).toHaveBeenCalledTimes(2); // user_owns_book + one create call
  });

  // The probe is the ONLY thing allowed to move a possibly-live attempt
  // to terminal, and only after an authenticated provider retrieval.
  it.each(["conflict_attempt_unresolved", "blocked_expired_attempt_unresolved"])(
    "probes the provider before deciding anything about a %s attempt", async (status) => {
    quote(status);
    mockProbe.mockResolvedValue({ kind: "ambiguous" });
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({
      target: msg("We can't safely reopen your previous checkout yet. Please try again in a few minutes."),
    });
    expect(mockProbe).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: INTENT, merchantId: "merchant" }),
      expect.anything(), expect.anything(),
    );
    expect(mockStartPok).not.toHaveBeenCalled();
  });

  it("sends a still-live conflicting quote to the book page's conflict notice, carrying only the intent id", async () => {
    quote("conflict_attempt_unresolved");
    mockProbe.mockResolvedValue({ kind: "resumable", url: CHECKOUT_URL });
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({
      target: `/books/book?checkout_conflict=${INTENT}`,
    });
    // The reader is NEVER silently sent to the old amount's checkout.
    expect(mockStartPok).not.toHaveBeenCalled();
  });

  it("mints exactly one replacement after a probe proves the attempt retired", async () => {
    quote("conflict_attempt_unresolved");
    mockProbe.mockResolvedValue({ kind: "retired" });
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "user_owns_book") return { data: false };
      return { data: args.p_accept_existing_quote ? quoteRows : mintedQuote(499, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb") };
    });
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({ target: CHECKOUT_URL });
    expect(mockStartPok).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
      expect.anything(), expect.anything(),
    );
  });

  it.each([
    [{ kind: "fulfilled", bookId: "book" }, "/books/book?purchase=success"],
    [{ kind: "fulfilment_pending", bookId: "book" }, null],
    [{ kind: "blocked", bookId: "book" }, null],
    [{ kind: "needs_reconciliation" }, null],
    [{ kind: "in_progress" }, null],
  ] as const)("never mints a replacement for probe outcome %j", async (resolution, target) => {
    quote("conflict_attempt_unresolved");
    mockProbe.mockResolvedValue(resolution);
    const call = buyBook("book", new FormData());
    if (target) {
      await expect(call).rejects.toMatchObject({ target });
    } else {
      await expect(call).rejects.toBeInstanceOf(RedirectSignal);
    }
    expect(mockStartPok).not.toHaveBeenCalled();
  });

  // ---- the deliberate resume, bound to one exact intent ----

  function resumeForm(intentId: string) {
    const form = new FormData();
    form.set("resume_existing", "1");
    form.set("expected_intent_id", intentId);
    return form;
  }

  it("passes the reader's deliberate acceptance through to SQL as the exact expected intent", async () => {
    quote("reused");
    await expect(buyBook("book", resumeForm(INTENT))).rejects.toMatchObject({ target: CHECKOUT_URL });
    expect(rpc).toHaveBeenCalledWith("create_book_checkout_intent", expect.objectContaining({
      p_accept_existing_quote: true, p_expected_intent_id: INTENT,
    }));
  });

  it("ignores a malformed expected_intent_id rather than resuming something else", async () => {
    quote("minted");
    await expect(buyBook("book", resumeForm("not-a-uuid"))).rejects.toMatchObject({ target: CHECKOUT_URL });
    expect(rpc).toHaveBeenCalledWith("create_book_checkout_intent", expect.objectContaining({
      p_accept_existing_quote: false, p_expected_intent_id: null,
    }));
  });

  it("re-evaluates ONCE when the accepted quote changed underneath, and never back into accept mode", async () => {
    quote("expected_intent_changed");
    const calls: Array<Record<string, unknown>> = [];
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === "user_owns_book") return { data: false };
      calls.push(args);
      return { data: calls.length === 1 ? quoteRows : mintedQuote(499, INTENT) };
    });
    await expect(buyBook("book", resumeForm(INTENT))).rejects.toMatchObject({ target: CHECKOUT_URL });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ p_accept_existing_quote: true, p_expected_intent_id: INTENT });
    expect(calls[1]).toMatchObject({ p_accept_existing_quote: false, p_expected_intent_id: null });
  });

  it("fails closed rather than looping when the re-evaluation changes again", async () => {
    quote("expected_intent_changed");
    await expect(buyBook("book", resumeForm(INTENT))).rejects.toMatchObject({
      target: msg("We can't safely reopen your previous checkout yet. Please try again in a few minutes."),
    });
    expect(mockStartPok).not.toHaveBeenCalled();
  });

  // The accepted quote lapsed between the notice and the click. Minting
  // a replacement here would charge a different amount than the one the
  // reader just confirmed, so it never happens on this path.
  it("tells the reader their accepted quote lapsed instead of silently re-pricing it", async () => {
    quote("blocked_expired_attempt_unresolved");
    mockProbe.mockResolvedValue({ kind: "retired" });
    await expect(buyBook("book", resumeForm(INTENT))).rejects.toMatchObject({
      target: "/books/book?checkout_expired=1",
    });
    expect(mockStartPok).not.toHaveBeenCalled();
  });

  // ---- the claim race, resolved into a retirement mid-start ----

  it("allows exactly one replacement when startPokCheckout reports the attempt retired", async () => {
    quote("minted");
    mockStartPok
      .mockRejectedValueOnce(new Error("POK_CHECKOUT_ATTEMPT_RETIRED"))
      .mockResolvedValueOnce(checkoutUrlResult);
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({ target: CHECKOUT_URL });
    expect(mockStartPok).toHaveBeenCalledTimes(2);
  });

  it("never loops: a second retirement report fails closed instead of minting again", async () => {
    quote("minted");
    mockStartPok.mockRejectedValue(new Error("POK_CHECKOUT_ATTEMPT_RETIRED"));
    await expect(buyBook("book", new FormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockStartPok).toHaveBeenCalledTimes(2);
  });

  it("never mints a replacement on the deliberate-accept path even when the attempt is retired mid-start", async () => {
    quote("reused");
    mockStartPok.mockRejectedValue(new Error("POK_CHECKOUT_ATTEMPT_RETIRED"));
    await expect(buyBook("book", resumeForm(INTENT))).rejects.toMatchObject({
      target: msg("We can't safely reopen your previous checkout yet. Please try again in a few minutes."),
    });
    expect(mockStartPok).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["POK_CHECKOUT_IN_PROGRESS", "Your checkout is starting. Please try again in a moment."],
    ["POK_CHECKOUT_AMBIGUOUS", "We can't safely reopen your previous checkout yet. Please try again in a few minutes."],
  ])("maps the %s sentinel to its own message", async (sentinel, text) => {
    quote("minted");
    mockStartPok.mockRejectedValue(new Error(sentinel));
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({ target: msg(text) });
  });

  it.each([
    [{ kind: "fulfilled", bookId: "book" }, "/books/book?purchase=success"],
    [{ kind: "fulfilment_pending", bookId: "book" },
      "/books/book?error=We%20haven't%20been%20able%20to%20confirm%20your%20payment%20yet.%20Check%20your%20library%20in%20a%20few%20minutes%20before%20paying%20again."],
    [{ kind: "blocked", bookId: "book" },
      "/books/book?error=This%20purchase%20needs%20review.%20If%20you%20already%20paid%2C%20check%20your%20library%3B%20otherwise%20please%20contact%20support."],
  ] as const)("routes the %j checkout result away from a second payable link", async (result, target) => {
    quote("minted");
    mockStartPok.mockResolvedValue(result);
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({ target });
  });

  it("fails closed on a malformed quote row rather than guessing a price", async () => {
    quoteRows = [{ intent_id: INTENT, price_cents_at_checkout: null, expires_at: null, quote_status: "minted" }];
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({
      target: "/books/book?error=Could+not+start+checkout",
    });
    expect(mockStartPok).not.toHaveBeenCalled();
  });

  it("fails closed on an unrecognized quote status", async () => {
    quote("some_status_this_code_has_never_seen");
    await expect(buyBook("book", new FormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockStartPok).not.toHaveBeenCalled();
  });
});
