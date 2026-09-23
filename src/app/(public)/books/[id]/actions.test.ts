import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { id: "book", title: "Test", price_all: 499, author_id: "author", status: "published", profiles: null } }) }) }) }) });
  });
  afterEach(() => vi.unstubAllEnvs());
  it("starts POK with a frozen ALL intent and no Stripe key/account dependency", async () => {
    await expect(buyBook("book", new FormData())).rejects.toMatchObject({ target: "https://pay-staging.pokpay.io/sdk-orders/test" });
    // ALL-WIRING-2: exactly four arguments, and NONE of the three
    // removed ones. `toEqual` (not objectContaining) is the point: an
    // extra p_regime/p_currency/p_royalty_rate_bps in the payload would
    // now fail to resolve against the only signature that exists.
    expect(rpc).toHaveBeenCalledWith("create_book_checkout_intent", {
      book_id: "book",
      p_discount_code: null,
      p_accept_existing_quote: false,
      p_expected_intent_id: null,
    });
    const intentCall = rpc.mock.calls.find(
      (call: unknown[]) => call[0] === "create_book_checkout_intent",
    ) as [string, Record<string, unknown>];
    expect(Object.keys(intentCall[1]).sort()).toEqual([
      "book_id",
      "p_accept_existing_quote",
      "p_discount_code",
      "p_expected_intent_id",
    ]);
    for (const removed of ["p_regime", "p_currency", "p_royalty_rate_bps"]) {
      expect(intentCall[1]).not.toHaveProperty(removed);
    }
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
              data: { id: "book", title: "Test", price_all: 499, author_id: "author", status: "published" },
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
      price_all: 999,
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
      data: { id: BOOK_ID, price_all: 0, status: "published", author_id: AUTHOR_ID },
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
      data: { id: BOOK_ID, price_all: 999, status: "published", author_id: AUTHOR_ID },
      error: null,
    });

    await expect(getFreeBook(BOOK_ID)).rejects.toMatchObject({ target: `/books/${BOOK_ID}` });

    expect(mockPurchasesUpsert).not.toHaveBeenCalled();
  });

  // ALL-WIRING-2: `price_all === 0` EXACTLY. Each case below is a value
  // that some weaker test would have let through -- `<= 0`, a falsy
  // check, a `price_cents` fallback, or a Number() coercion -- and each
  // must end in a refusal with nothing written.
  it.each([
    ["null: no authored ALL price at all", null],
    ["undefined: the column absent from the row", undefined],
    ["the string zero, never coerced", "0"],
    ["negative zero is not the free value", -0.0000001],
    ["the paid floor", 99],
    ["a legacy-looking 199", 199],
    ["an out-of-domain 50", 50],
  ])("refuses a free claim for %s, writing nothing", async (_label, priceAll) => {
    mockBookSingle.mockResolvedValue({
      data: { id: BOOK_ID, price_all: priceAll, status: "published", author_id: AUTHOR_ID },
      error: null,
    });

    await expect(getFreeBook(BOOK_ID)).rejects.toMatchObject({ target: `/books/${BOOK_ID}` });

    expect(mockPurchasesUpsert).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockStartPok).not.toHaveBeenCalled();
  });

  // The legacy row this patch exists for, in the direction that costs
  // money: price_all 199 beside a price_cents of 0. A fallback to the
  // legacy column would give this book away.
  it("never gives away a 199-lek book whose legacy price_cents is 0", async () => {
    mockBookSingle.mockResolvedValue({
      data: {
        id: BOOK_ID, price_all: 199, price_cents: 0,
        status: "published", author_id: AUTHOR_ID,
      },
      error: null,
    });

    await expect(getFreeBook(BOOK_ID)).rejects.toMatchObject({ target: `/books/${BOOK_ID}` });

    expect(mockPurchasesUpsert).not.toHaveBeenCalled();
  });

  // ...and the mirror case: a genuinely free book whose legacy column
  // says 9900 is still free, so the cutover cannot accidentally start
  // charging for it either.
  it("still gives away a price_all 0 book whose legacy price_cents is 9900", async () => {
    mockBookSingle.mockResolvedValue({
      data: {
        id: BOOK_ID, price_all: 0, price_cents: 9900,
        status: "published", author_id: AUTHOR_ID,
      },
      error: null,
    });

    await expect(getFreeBook(BOOK_ID)).rejects.toMatchObject({
      target: `/books/${BOOK_ID}?free=success`,
    });
    expect(mockPurchasesUpsert).toHaveBeenCalled();
  });

  it("the successful claim creates a zero-amount entitlement and NOTHING else", async () => {
    await expect(getFreeBook(BOOK_ID)).rejects.toMatchObject({
      target: `/books/${BOOK_ID}?free=success`,
    });

    // Exactly one write, to purchases, at amount 0.
    expect(mockPurchasesUpsert).toHaveBeenCalledTimes(1);
    const row = mockPurchasesUpsert.mock.calls[0][0] as Record<string, unknown>;
    expect(row.amount_cents).toBe(0);
    // No provider call, no payment row of any other kind, and no
    // author-ledger sale entry: the admin client only ever reaches
    // `purchases` here (the mock throws for any other table), and no
    // checkout-intent or ledger RPC is issued.
    expect(mockStartPok).not.toHaveBeenCalled();
    expect(mockPokConfig).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    const rpcNames = mockRpc.mock.calls.map((call: unknown[]) => call[0]);
    expect(rpcNames).toEqual(["user_owns_book"]);
    for (const forbidden of [
      "create_book_checkout_intent",
      "finalize_book_checkout_intent",
      "record_author_sale",
    ]) {
      expect(rpcNames).not.toContain(forbidden);
    }
  });

  // Free acquisition is deliberately independent of paid-checkout
  // readiness: there is nothing on this path for a paid-mode permission
  // to govern, so the absence of PAID_CHECKOUT_MODE must not close it.
  it("still works with PAID_CHECKOUT_MODE absent and no provider configured at all", async () => {
    vi.stubEnv("PAID_CHECKOUT_MODE", "");
    vi.stubEnv("NEW_CHECKOUT_REGIME", "");
    vi.stubEnv("LEDGER_PAYMENT_PROVIDER", "");
    vi.stubEnv("STRIPE_SECRET_KEY", "");

    await expect(getFreeBook(BOOK_ID)).rejects.toMatchObject({
      target: `/books/${BOOK_ID}?free=success`,
    });
    expect(mockPurchasesUpsert).toHaveBeenCalledTimes(1);

    vi.unstubAllEnvs();
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
                  data: { id: BOOK_ID, title: "T", price_all: 999, status: "published", author_id: AUTHOR_ID },
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
        data: { id: "book", title: "Test", price_all: 499, author_id: "author", status: "published", profiles: null },
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

// ============================================================
// ALL-WIRING-2: buyBook's own three-way fork on `price_all`, plus the
// two discount rejections the four-argument RPC can now return.
// ============================================================
describe("buyBook: the catalog price decides, and null is neither free nor paid", () => {
  const READER = "reader";
  let rpc: ReturnType<typeof vi.fn>;
  let bookRow: Record<string, unknown>;

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
    bookRow = { id: "book", title: "Test", price_all: 499, author_id: "author", status: "published", profiles: null };
    rpc = vi.fn().mockImplementation(async (name: string) =>
      name === "user_owns_book" ? { data: false } : { data: mintedQuote(499) });
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: READER } } }) },
      rpc,
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: bookRow }) }) }) }),
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  // An unpriced book has nothing to charge and nothing to give away.
  // The refusal must come BEFORE the RPC, because minting a checkout
  // intent for a null price is what would actually break.
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["an out-of-domain 50", 50],
    ["an out-of-domain 100001", 100001],
  ])("refuses a purchase of a book priced %s, before any intent is minted", async (_label, priceAll) => {
    bookRow = { ...bookRow, price_all: priceAll };

    await expect(buyBook("book", new FormData())).rejects.toMatchObject({
      target: "/books/book?error=This+book+isn%27t+available+to+buy+right+now",
    });

    expect(rpc).not.toHaveBeenCalledWith("create_book_checkout_intent", expect.anything());
    expect(mockStartPok).not.toHaveBeenCalled();
    expect(mockPokConfig).not.toHaveBeenCalled();
  });

  it("its message never says the book is free, and never offers a price", async () => {
    bookRow = { ...bookRow, price_all: null };
    await expect(buyBook("book", new FormData())).rejects.toBeInstanceOf(RedirectSignal);
    const target = decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string);
    expect(target).not.toMatch(/free/i);
    expect(target).not.toContain("$");
    expect(target).not.toMatch(/ALL\b/);
    expect(target).not.toMatch(/price_all|price_cents/);
  });

  it("a free book is sent to the free-acquisition path, never to a provider", async () => {
    bookRow = { ...bookRow, price_all: 0 };

    await expect(buyBook("book", new FormData())).rejects.toBeInstanceOf(RedirectSignal);

    expect(rpc).not.toHaveBeenCalledWith("create_book_checkout_intent", expect.anything());
    expect(mockStartPok).not.toHaveBeenCalled();
  });

  // The legacy row, again, at the one decision where getting it wrong
  // hands away a paid book.
  it("price_all 199 beside a legacy price_cents 0 goes to PAID checkout", async () => {
    bookRow = { ...bookRow, price_all: 199, price_cents: 0 };
    rpc = vi.fn().mockImplementation(async (name: string) =>
      name === "user_owns_book" ? { data: false } : { data: mintedQuote(19900) });
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: READER } } }) },
      rpc,
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: bookRow }) }) }) }),
    });

    await expect(buyBook("book", new FormData())).rejects.toMatchObject({ target: CHECKOUT_URL });

    expect(rpc).toHaveBeenCalledWith("create_book_checkout_intent", expect.anything());
    expect(mockStartPok).toHaveBeenCalled();
  });

  it("the row the action reads carries price_all and not price_cents", async () => {
    const source = readFileSync(fileURLToPath(new URL("./actions.ts", import.meta.url)), "utf8");
    expect(source).toContain('.select("id, title, price_all, status, author_id")');
    expect(source).toContain('.select("id, price_all, status, author_id")');
    expect(source).not.toMatch(/\.select\("[^"]*\bprice_cents\b[^"]*"\)/);
  });
});

describe("buyBook: the two new discount rejections are honest and charge nothing", () => {
  const READER = "reader";
  const INTENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let rpc: ReturnType<typeof vi.fn>;
  let quoteRows: unknown[];

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
    quoteRows = mintedQuote(49900, INTENT);
    rpc = vi.fn().mockImplementation(async (name: string) =>
      name === "user_owns_book" ? { data: false } : { data: quoteRows });
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: READER } } }) },
      rpc,
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({
        data: { id: "book", title: "Test", price_all: 499, author_id: "author", status: "published", profiles: null },
      }) }) }) }),
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  function quote(status: string) {
    quoteRows = [{ intent_id: INTENT, price_cents_at_checkout: 49900, discount_code_id: null,
      expires_at: "2026-09-15T10:30:00Z", quote_status: status }];
  }

  // The RPC returns both of these BEFORE its first mutation, so the
  // whole handling is to stop. The forbidden outcomes are (a) telling
  // the reader the code was applied, and (b) quietly charging the full
  // price as though they had never entered one.
  it.each(["discount_not_applicable", "discount_below_minimum"])(
    "%s stops checkout dead: no provider call, no second intent",
    async (status) => {
      quote(status);

      await expect(buyBook("book", new FormData())).rejects.toBeInstanceOf(RedirectSignal);

      expect(mockStartPok).not.toHaveBeenCalled();
      expect(mockProbe).not.toHaveBeenCalled();
      // user_owns_book + exactly one create call, never a retry that
      // drops the code and charges full price.
      expect(rpc).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["discount_not_applicable", "can't be used for this book"],
    ["discount_below_minimum", "below Librum's minimum price"],
  ])("%s gets its OWN message, naming the real reason", async (status, fragment) => {
    quote(status);
    await expect(buyBook("book", new FormData())).rejects.toBeInstanceOf(RedirectSignal);
    const target = decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string);
    expect(target).toContain(fragment);
  });

  it("neither message ever claims a discount was applied, and both say nothing was charged", async () => {
    for (const status of ["discount_not_applicable", "discount_below_minimum"]) {
      mockRedirect.mockClear();
      quote(status);
      await expect(buyBook("book", new FormData())).rejects.toBeInstanceOf(RedirectSignal);
      const target = decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string);
      expect(target).toMatch(/nothing was charged/i);
      expect(target).not.toMatch(/discount applied|code applied|applied your/i);
      // No clamped or "adjusted" price is ever quoted back.
      expect(target).not.toMatch(/\d+[.,]\d{2}/);
      expect(target).not.toContain("$");
    }
  });

  it("the two messages are different from each other and from the generic failure", async () => {
    const seen: string[] = [];
    for (const status of ["discount_not_applicable", "discount_below_minimum"]) {
      mockRedirect.mockClear();
      quote(status);
      await expect(buyBook("book", new FormData())).rejects.toBeInstanceOf(RedirectSignal);
      seen.push(decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string));
    }
    expect(seen[0]).not.toBe(seen[1]);
    for (const message of seen) {
      expect(message).not.toContain("Could not start checkout");
    }
  });
});

// ============================================================
// ALL-WIRING-2 CORRECTION (Codex finding 2): a discount rejection
// returned by a REPLACEMENT quote is classified the same way as one
// returned by the initial quote.
//
// buyBook calls createQuote from four places. Two of them -- the
// replacement minted after a provider probe proves the old attempt
// retired, and the replacement minted after POK_CHECKOUT_ATTEMPT_RETIRED
// -- previously accepted only `minted` or `reused` and folded everything
// else into the generic "try again in a few minutes" message. Discount
// eligibility can genuinely change between the first RPC and the
// replacement (a code expiring, a price moving, the code being an ALL-
// incompatible legacy row), so a reader on those paths was told to
// retry when the truthful answer was that their code was not applied.
//
// The classification now lives inside createQuote and the two statuses
// are removed from its return TYPE, so every call site is covered by
// construction. These tests prove that mechanically, from both
// replacement locations, for both statuses.
// ============================================================
describe("buyBook: discount rejections on a REPLACEMENT quote", () => {
  const READER = "reader";
  const INTENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  let rpc: ReturnType<typeof vi.fn>;
  let quoteRows: unknown[];
  let quoteCalls: number;

  const NOT_APPLICABLE =
    "That promo code can't be used for this book, so nothing was charged. Remove the code to buy at the current price.";
  const BELOW_MINIMUM =
    "That promo code would bring this book below Librum's minimum price, so it can't be used and nothing was charged.";
  const GENERIC_AMBIGUOUS =
    "We can't safely reopen your previous checkout yet. Please try again in a few minutes.";

  function msg(text: string) {
    return `/books/book?error=${encodeURIComponent(text)}`;
  }

  function row(status: string) {
    return [{ intent_id: INTENT, price_cents_at_checkout: 49900, discount_code_id: null,
      expires_at: "2026-09-15T10:30:00Z", quote_status: status }];
  }

  // A reader who actually typed a code -- otherwise the scenario is not
  // the one under test.
  function formWithCode() {
    const form = new FormData();
    form.set("code", "SUMMER");
    return form;
  }

  beforeEach(() => {
    vi.stubEnv("NEW_CHECKOUT_REGIME", "librum_ledger_v1");
    vi.stubEnv("LEDGER_PAYMENT_PROVIDER", "pok");
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    stubPaidCheckoutAllowed();
    mockCookieStore.get.mockImplementation(() => undefined);
    mockRedirect.mockClear();
    // The getFreeBook block installs an admin-client stub that throws on
    // any table but "purchases"; without this reset it leaks in here and
    // masks the behaviour under test.
    //
    // The code SUMMER is deliberately valid, active and unexpired, so it
    // clears buyBook's cheap early "is this code real" lookup. That is
    // the scenario under test: the reader typed a genuine code, and it
    // is the AUTHORITATIVE RPC that refuses it. A code that failed the
    // early check would never reach a quote at all.
    mockCreateAdminClient.mockReset().mockReturnValue({
      from: (table: string) => {
        if (table !== "discount_codes") {
          throw new Error(`replacement-rejection tests: unexpected admin table "${table}"`);
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: { id: "discount", code: "SUMMER", book_id: "book", active: true, expires_at: null },
                  }),
                }),
              }),
            }),
          }),
        };
      },
    });
    mockPokConfig.mockReset().mockReturnValue({ merchantId: "merchant", keyId: "k", keySecret: "s" });
    mockPokClient.mockReset().mockReturnValue({});
    mockPokRepository.mockReset().mockReturnValue({});
    mockStartPok.mockReset().mockResolvedValue(checkoutUrlResult);
    mockProbe.mockReset();
    quoteCalls = 0;
    quoteRows = mintedQuote(49900, INTENT);
    rpc = vi.fn().mockImplementation(async (name: string) => {
      if (name === "user_owns_book") return { data: false };
      quoteCalls += 1;
      return { data: quoteRows };
    });
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: READER } } }) },
      rpc,
      from: () => ({ select: () => ({ eq: () => ({ single: async () => ({
        data: { id: "book", title: "Test", price_all: 499, author_id: "author", status: "published", profiles: null },
      }) }) }) }),
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  /** Asserts the shared contract every discount rejection must satisfy. */
  function assertHonestRejection(expected: string) {
    const target = decodeURIComponent(mockRedirect.mock.calls.at(-1)?.[0] as string);
    // The exact, status-specific message.
    expect(target).toBe(decodeURIComponent(msg(expected)));
    // ...never the generic "try again in a few minutes".
    expect(target).not.toContain(GENERIC_AMBIGUOUS);
    // States plainly that nothing was charged.
    expect(target).toMatch(/nothing was charged/i);
    // Never claims the code was applied.
    expect(target).not.toMatch(/discount applied|code applied|applied your/i);
    // Quotes no amount at all -- neither an adjusted one nor a
    // full-price fallback.
    expect(target).not.toMatch(/\d+[.,]\d{2}/);
    expect(target).not.toMatch(/\bALL\b/);
    expect(target).not.toContain("$");
    expect(target).not.toContain("49900");
    expect(target).not.toContain("499");
    // POK is never reached for the REJECTED quote. At most one call can
    // legitimately exist across these scenarios: the first attempt in
    // case B, which is what reported the retirement. `not.toHaveBeenCalledTimes(2)`
    // would let three through, so assert the bound instead.
    expect(mockStartPok.mock.calls.length).toBeLessThanOrEqual(1);
  }

  // ---- A. the replacement minted after a provider probe retires the
  //         old attempt ----
  describe.each([
    ["discount_not_applicable", NOT_APPLICABLE],
    ["discount_below_minimum", BELOW_MINIMUM],
  ])("A. provider-probe retirement replacement returning %s", (status, expected) => {
    beforeEach(() => {
      // Initial quote: the old attempt may still be payable.
      quoteRows = row("conflict_attempt_unresolved");
      mockProbe.mockResolvedValue({ kind: "retired" });
      // The REPLACEMENT is the one that comes back rejected.
      rpc.mockImplementation(async (name: string) => {
        if (name === "user_owns_book") return { data: false };
        quoteCalls += 1;
        return { data: quoteCalls === 1 ? row("conflict_attempt_unresolved") : row(status) };
      });
    });

    it("returns the exact status-specific message, never the generic one", async () => {
      await expect(buyBook("book", formWithCode())).rejects.toBeInstanceOf(RedirectSignal);
      assertHonestRejection(expected);
    });

    it("starts no POK checkout", async () => {
      await expect(buyBook("book", formWithCode())).rejects.toBeInstanceOf(RedirectSignal);
      expect(mockStartPok).not.toHaveBeenCalled();
    });

    it("makes no further createQuote call, and no retry without the code", async () => {
      await expect(buyBook("book", formWithCode())).rejects.toBeInstanceOf(RedirectSignal);
      // Exactly two: the initial quote and the one replacement. The
      // one-replacement maximum is intact, and the code was never
      // silently dropped for a third, undiscounted attempt.
      expect(quoteCalls).toBe(2);
      const quoteArgs = rpc.mock.calls
        .filter((call: unknown[]) => call[0] === "create_book_checkout_intent")
        .map((call: unknown[]) => call[1] as Record<string, unknown>);
      expect(quoteArgs).toHaveLength(2);
      for (const args of quoteArgs) {
        expect(args.p_discount_code).toBe("SUMMER");
      }
    });
  });

  // ---- B. the replacement minted after POK_CHECKOUT_ATTEMPT_RETIRED ----
  describe.each([
    ["discount_not_applicable", NOT_APPLICABLE],
    ["discount_below_minimum", BELOW_MINIMUM],
  ])("B. POK_CHECKOUT_ATTEMPT_RETIRED replacement returning %s", (status, expected) => {
    beforeEach(() => {
      // The initial quote is fine; the claim race resolves into a
      // retirement while the provider order is being created.
      rpc.mockImplementation(async (name: string) => {
        if (name === "user_owns_book") return { data: false };
        quoteCalls += 1;
        return { data: quoteCalls === 1 ? mintedQuote(49900, INTENT) : row(status) };
      });
      mockStartPok.mockReset().mockRejectedValue(new Error("POK_CHECKOUT_ATTEMPT_RETIRED"));
    });

    it("returns the exact status-specific message, never the generic one", async () => {
      await expect(buyBook("book", formWithCode())).rejects.toBeInstanceOf(RedirectSignal);
      assertHonestRejection(expected);
    });

    it("starts no SECOND POK checkout for the rejected replacement", async () => {
      await expect(buyBook("book", formWithCode())).rejects.toBeInstanceOf(RedirectSignal);
      // The first attempt is what reported the retirement; the
      // replacement never reaches the provider at all.
      expect(mockStartPok).toHaveBeenCalledTimes(1);
    });

    it("makes no further createQuote call, and no retry without the code", async () => {
      await expect(buyBook("book", formWithCode())).rejects.toBeInstanceOf(RedirectSignal);
      expect(quoteCalls).toBe(2);
      const quoteArgs = rpc.mock.calls
        .filter((call: unknown[]) => call[0] === "create_book_checkout_intent")
        .map((call: unknown[]) => call[1] as Record<string, unknown>);
      expect(quoteArgs).toHaveLength(2);
      for (const args of quoteArgs) {
        expect(args.p_discount_code).toBe("SUMMER");
      }
    });
  });

  // ---- C. the expected_intent_changed re-evaluation, for completeness:
  //         the fourth createQuote call site ----
  describe.each([
    ["discount_not_applicable", NOT_APPLICABLE],
    ["discount_below_minimum", BELOW_MINIMUM],
  ])("C. expected_intent_changed re-evaluation returning %s", (status, expected) => {
    it("returns the exact status-specific message, never the generic one", async () => {
      rpc.mockImplementation(async (name: string) => {
        if (name === "user_owns_book") return { data: false };
        quoteCalls += 1;
        return { data: quoteCalls === 1 ? row("expected_intent_changed") : row(status) };
      });
      const form = formWithCode();
      form.set("resume_existing", "1");
      form.set("expected_intent_id", INTENT);

      await expect(buyBook("book", form)).rejects.toBeInstanceOf(RedirectSignal);

      assertHonestRejection(expected);
      expect(mockStartPok).not.toHaveBeenCalled();
      expect(quoteCalls).toBe(2);
    });
  });

  // ---- D. every createQuote call site is mechanically covered ----
  it("the initial quote still rejects both statuses, so all four call sites are covered", async () => {
    for (const [status, expected] of [
      ["discount_not_applicable", NOT_APPLICABLE],
      ["discount_below_minimum", BELOW_MINIMUM],
    ] as Array<[string, string]>) {
      mockRedirect.mockClear();
      mockStartPok.mockReset().mockResolvedValue(checkoutUrlResult);
      quoteCalls = 0;
      quoteRows = row(status);
      await expect(buyBook("book", formWithCode())).rejects.toBeInstanceOf(RedirectSignal);
      assertHonestRejection(expected);
      expect(quoteCalls).toBe(1);
    }
  });

  // The structural guarantee, asserted rather than described: buyBook
  // has exactly four createQuote call sites and ONE place that
  // classifies the two discount statuses.
  it("classifies the two statuses in exactly one place in the source", async () => {
    const source = readFileSync(fileURLToPath(new URL("./actions.ts", import.meta.url)), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    // Each status is compared in exactly ONE place, and that place is the
    // screening inside createQuote (the only `row.`-prefixed comparison).
    // Any second, divergent copy at a call site would push these past 1.
    for (const status of ["discount_not_applicable", "discount_below_minimum"]) {
      const all = code.match(new RegExp(`quote_status === "${status}"`, "g")) ?? [];
      const screened = code.match(new RegExp(`row\\.quote_status === "${status}"`, "g")) ?? [];
      expect(all).toHaveLength(1);
      expect(screened).toHaveLength(1);
    }
    // Four call sites, all funnelled through that one screening.
    expect(code.match(/await createQuote\(/g)).toHaveLength(4);
  });
});
