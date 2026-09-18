import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";
import { STAGING_SUPABASE_URL } from "@/lib/protected-staging";

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
  getStripe: () => ({
    checkout: { sessions: { create: mockCheckoutSessionsCreate } },
    accounts: { retrieve: (...args: unknown[]) => mockAccountsRetrieve(...args) },
  }),
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

// STRIPE-DISABLE-1: buyBundle's legacy Connect-gate branch (LIBRUM 2.0
// CONNECT-HARDEN-1) and its ledger_v1 Stripe-fallback branch (STRIPE-
// CUTOVER-2A Section 33) have both been REMOVED -- paid bundle checkout
// is unavailable under every configuration until separate POK bundle
// support is reviewed (locked product decision). The tests that used to
// live in this file for those two branches asserted the exact
// fail-OPEN-to-Stripe behavior this patch removes, so they are
// superseded, not weakened -- replaced below by a matrix proving
// buyBundle now fails closed, with zero DB/RPC/Stripe/POK calls of any
// kind, for every configuration (including the one-time exact POK
// config, since POK phase one still supports single books only).
describe("buyBundle: fails closed under every configuration (STRIPE-DISABLE-1)", () => {
  const BUNDLE_ID = "bundle-1";
  const READER_ID = "reader-1";
  const UNAVAILABLE_PREFIX = `/bundles/${BUNDLE_ID}?error=`;
  const ORIGINAL_REGIME = process.env.NEW_CHECKOUT_REGIME;
  const ORIGINAL_PROVIDER = process.env.LEDGER_PAYMENT_PROVIDER;

  let mockBundleSingle = vi.fn();
  let mockBundleBooksSelect = vi.fn();
  let mockRpc = vi.fn();

  beforeEach(() => {
    mockRedirect.mockClear();
    mockAccountsRetrieve.mockReset();
    mockCheckoutSessionsCreate.mockReset();
    mockCreateAdminClient.mockReset();
    mockCookieStore.get.mockImplementation(() => undefined);

    mockBundleSingle = vi.fn();
    mockBundleBooksSelect = vi.fn();
    mockRpc = vi.fn();
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: READER_ID } } }) },
      from: (table: string) => {
        if (table === "bundles") {
          return { select: () => ({ eq: () => ({ single: () => mockBundleSingle() }) }) };
        }
        if (table === "bundle_books") {
          return { select: () => ({ eq: () => mockBundleBooksSelect() }) };
        }
        throw new Error(`buyBundle fail-closed tests: unexpected table "${table}"`);
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

  const configs: Array<[string, string | undefined, string | undefined]> = [
    ["both env vars unset (pre-cutover default)", undefined, undefined],
    ["legacy regime explicit", "legacy_stripe_connect_v1", undefined],
    ["ledger regime, provider stripe", "librum_ledger_v1", "stripe"],
    // Even the one config that enables POK for BOOKS must still fail
    // closed here -- POK phase one supports single books only.
    ["ledger regime, provider pok (still unsupported for bundles)", "librum_ledger_v1", "pok"],
    ["unrecognized regime, provider pok", "not_a_real_regime", "pok"],
  ];

  it.each(configs)(
    "%s: rejects before any bundle/membership read, RPC, or Stripe/POK call",
    async (_label, regime, provider) => {
      delete process.env.NEW_CHECKOUT_REGIME;
      delete process.env.LEDGER_PAYMENT_PROVIDER;
      if (regime !== undefined) process.env.NEW_CHECKOUT_REGIME = regime;
      if (provider !== undefined) process.env.LEDGER_PAYMENT_PROVIDER = provider;

      await expect(buyBundle(BUNDLE_ID)).rejects.toMatchObject({
        target: expect.stringContaining(UNAVAILABLE_PREFIX),
      });

      expect(mockBundleSingle).not.toHaveBeenCalled();
      expect(mockBundleBooksSelect).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockAccountsRetrieve).not.toHaveBeenCalled();
      expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
      expect(mockCreateAdminClient).not.toHaveBeenCalled();
    },
  );

  it("an unauthenticated reader is still sent to login first, never the disabled notice", async () => {
    mockCreateClient.mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
      from: () => {
        throw new Error("must not query any table before the login redirect");
      },
      rpc: () => {
        throw new Error("must not call any RPC before the login redirect");
      },
    });

    await expect(buyBundle(BUNDLE_ID)).rejects.toMatchObject({
      target: expect.stringContaining(`/login?next=/bundles/${BUNDLE_ID}`),
    });
  });
});

// APP A CORRECTION 2: proves buyBundle rejects through the maintenance
// contract before redirectIfRecoverySessionActive() (the cookie read),
// its own disabled-checkout logic, or any Supabase/Stripe/POK
// dependency call above -- gated first per this file's own
// ALL-CUTOVER APP-A comment, even though buyBundle is already
// unconditionally disabled today.
describe("buyBundle: maintenance-mode gate", () => {
  const BUNDLE_ID = "bundle-1";

  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    mockCreateAdminClient.mockClear();
    mockCheckoutSessionsCreate.mockClear();
    mockCookieStore.get.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("redirects with the maintenance message before the recovery-session cookie read or any Supabase/Stripe call", async () => {
    await expect(buyBundle(BUNDLE_ID)).rejects.toMatchObject({
      target: expect.stringContaining(`/bundles/${BUNDLE_ID}?error=`),
    });

    expect(mockCookieStore.get).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves buyBundle's existing recovery-session check", async () => {
    vi.unstubAllEnvs();
    mockCookieStore.get.mockImplementation((name: string) =>
      name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined,
    );

    await expect(buyBundle(BUNDLE_ID)).rejects.toMatchObject({
      target: expect.stringContaining("/reset-password"),
    });
    expect(mockCookieStore.get).toHaveBeenCalled();
  });
});

// PAID-MODE-1: buyBundle is deliberately NOT wired to the paid-mode
// gate. Its exit is an unconditional redirect, and a satisfiable guard
// would be weaker than a welded door -- so these tests prove the door
// stays welded, under every combination of the new variables, and that
// no later edit quietly replaces it with a condition.
describe("buyBundle: unconditional closure is not softened (PAID-MODE-1)", () => {
  const BUNDLE_ID = "bundle-1";

  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockReset().mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "reader-1" } } }) },
    });
    mockCreateAdminClient.mockReset();
    mockCheckoutSessionsCreate.mockReset();
    mockCookieStore.get.mockImplementation(() => undefined);
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["no paid-mode variables at all", {}],
    [
      "checkout mode set on the exact protected staging deployment",
      {
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "staging",
        NEXT_PUBLIC_SUPABASE_URL: STAGING_SUPABASE_URL,
        PAID_CHECKOUT_MODE: "controlled_staging_checkout_test",
      },
    ],
    [
      "both modes set, provider fully configured",
      {
        VERCEL_ENV: "preview",
        VERCEL_GIT_COMMIT_REF: "staging",
        NEXT_PUBLIC_SUPABASE_URL: STAGING_SUPABASE_URL,
        PAID_CHECKOUT_MODE: "controlled_staging_checkout_test",
        PAID_PUBLISHING_MODE: "controlled_staging_publishing_test",
        NEW_CHECKOUT_REGIME: "librum_ledger_v1",
        LEDGER_PAYMENT_PROVIDER: "pok",
        POK_ENVIRONMENT: "staging",
      },
    ],
  ])("stays closed with %s", async (_label, env) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);

    await expect(buyBundle(BUNDLE_ID)).rejects.toMatchObject({
      target: expect.stringContaining(`/bundles/${BUNDLE_ID}?error=`),
    });
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  // A source assertion, not a behavioural one, and deliberately so: the
  // guarantee worth protecting is that this action never acquires a
  // CONDITION at all. A behavioural test cannot tell "unconditionally
  // closed" apart from "closed because the mode happens to be unset".
  it("its source contains no paid-mode call", () => {
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "actions.ts"),
      "utf8",
    );
    expect(source).not.toContain("canStartPaidCheckout");
    expect(source).not.toContain("canPublishPaidTitle");
    expect(source).not.toContain("paid-readiness");
  });
});
