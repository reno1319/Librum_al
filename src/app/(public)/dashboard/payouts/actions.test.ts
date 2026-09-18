import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// LAUNCH-1 P2-1: connectStripeAccount() get-or-creates a Stripe Connect
// Express account and persists its id onto the author's own profiles
// row. This file covers the persistence-hardening logic added in that
// turn -- the profile-read failure guard, the deterministic idempotency
// key, the conditional (WHERE stripe_account_id IS NULL) persistence
// write and its zero-row/conflicting-account reconciliation branch, and
// the Account Link failure behavior -- not Stripe/Supabase's own
// pre-existing semantics.
//
// AUTH-1C added a recovery-session defense-in-depth guard to BOTH
// connectStripeAccount() and openStripeExpressDashboard() -- see the
// dedicated describe blocks near the bottom of this file, which are
// also openStripeExpressDashboard()'s first-ever coverage (it was
// explicitly out of scope for the LAUNCH-1 P2-1 turn above).
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
  get: vi.fn((_name: string) => undefined as { value: string } | undefined),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockGetUser = vi.fn();
const mockProfileSingle = vi.fn();
const mockCreateClient = vi.fn(() =>
  Promise.resolve({
    auth: { getUser: mockGetUser },
    from: () => ({
      select: () => ({
        eq: () => ({
          single: () => mockProfileSingle(),
        }),
      }),
    }),
  }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const mockAdminUpdateSelect = vi.fn();
const mockAdminReReadMaybeSingle = vi.fn();
const mockCreateAdminClient = vi.fn(() => ({
  from: () => ({
    update: () => ({
      eq: () => ({
        is: () => ({
          select: () => mockAdminUpdateSelect(),
        }),
      }),
    }),
    select: () => ({
      eq: () => ({
        maybeSingle: () => mockAdminReReadMaybeSingle(),
      }),
    }),
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));

const mockAccountsCreate = vi.fn();
const mockAccountsRetrieve = vi.fn();
const mockAccountLinksCreate = vi.fn();
const mockCreateLoginLink = vi.fn();
// ALL-CUTOVER APP-A: wrapped in its own spy (not just the individual
// method mocks below it) so the maintenance-mode gate test can assert
// getStripe() itself is never even constructed, not merely that its
// methods went unused.
const mockGetStripe = vi.fn(() => ({
  accounts: {
    create: (...args: unknown[]) => mockAccountsCreate(...args),
    retrieve: (...args: unknown[]) => mockAccountsRetrieve(...args),
    createLoginLink: (...args: unknown[]) => mockCreateLoginLink(...args),
  },
  accountLinks: { create: (...args: unknown[]) => mockAccountLinksCreate(...args) },
}));
vi.mock("@/lib/stripe", () => ({ getStripe: () => mockGetStripe() }));

const { connectStripeAccount, openStripeExpressDashboard } = await import("./actions");

const USER_ID = "user-1";

function resetMocks() {
  mockRedirect.mockClear();
  mockCreateClient.mockClear();
  mockCreateAdminClient.mockClear();
  mockCookieStore.get.mockReset().mockImplementation(() => undefined);

  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID, email: "a@b.co" } } });
  mockProfileSingle.mockReset().mockResolvedValue({ data: { stripe_account_id: null }, error: null });
  mockAdminUpdateSelect
    .mockReset()
    .mockResolvedValue({ data: [{ stripe_account_id: "acct_new" }], error: null });
  mockAdminReReadMaybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
  mockAccountsCreate.mockReset().mockResolvedValue({ id: "acct_new" });
  mockAccountsRetrieve.mockReset().mockImplementation((id: string) =>
    Promise.resolve({ id, charges_enabled: true, payouts_enabled: true, details_submitted: true }),
  );
  mockAccountLinksCreate
    .mockReset()
    .mockResolvedValue({ url: "https://connect.stripe.com/setup/acct_new" });
  mockGetStripe.mockClear();
  mockCreateLoginLink.mockReset();
}

async function expectRedirectTo(promise: Promise<unknown>, target: string | RegExp) {
  await expect(promise).rejects.toBeInstanceOf(RedirectSignal);
  if (typeof target === "string") {
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(target));
  } else {
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringMatching(target));
  }
}

const GENERIC_FAILURE = "/dashboard/payouts?error=";

// STRIPE-DISABLE-1: connectStripeAccount's account-creation,
// idempotency-key, and persistence-reconciliation logic (LAUNCH-1 P2-1)
// and its live-reverification gate (LIBRUM 2.0 CONNECT-HARDEN-1) have
// all been REMOVED -- new Stripe Connect account creation, and finishing
// onboarding for an existing-but-not-yet-ready account, are both
// disabled under every configuration (locked product decision). The
// tests that used to live in this file for that logic asserted the
// exact account-creation behavior this patch removes, so they are
// superseded, not weakened -- replaced below by tests proving the
// action now fails closed unconditionally, before any profile read, any
// Stripe API call, and any DB mutation.
describe("connectStripeAccount (disabled -- STRIPE-DISABLE-1)", () => {
  beforeEach(resetMocks);

  it("no stripe_account_id on file: fails closed with zero Stripe calls and zero DB mutation", async () => {
    mockProfileSingle.mockResolvedValue({ data: { stripe_account_id: null }, error: null });

    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    expect(mockAccountsCreate).not.toHaveBeenCalled();
    expect(mockAccountsRetrieve).not.toHaveBeenCalled();
    expect(mockAccountLinksCreate).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("an existing, not-yet-payouts-ready stripe_account_id: also fails closed, never resumes onboarding", async () => {
    mockProfileSingle.mockResolvedValue({
      data: { stripe_account_id: "acct_pending" },
      error: null,
    });

    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    expect(mockAccountsCreate).not.toHaveBeenCalled();
    expect(mockAccountsRetrieve).not.toHaveBeenCalled();
    expect(mockAccountLinksCreate).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("never reads the author's profile at all -- the disabled redirect is unconditional", async () => {
    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    expect(mockProfileSingle).not.toHaveBeenCalled();
  });

  it("an unauthenticated caller is still sent to login first, never the disabled notice", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });

    await expectRedirectTo(connectStripeAccount(), "/login");

    expect(mockAccountsCreate).not.toHaveBeenCalled();
  });
});

// AUTH-1C: connectStripeAccount() controls where an author's future
// earnings are routed -- a payout-account-onboarding/connection action,
// exactly the kind of high-value mutation the recovery guard exists to
// block during a hijacked recovery window. Mirrors the "recovery-session
// defense-in-depth" pattern already established for buyBundle
// (src/app/bundles/[id]/actions.test.ts).
describe("connectStripeAccount: recovery-session defense-in-depth (AUTH-1C)", () => {
  beforeEach(resetMocks);

  it("redirects to /reset-password and never reaches Supabase or Stripe when a recovery session is active", async () => {
    mockCookieStore.get.mockImplementation((name: string) =>
      name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined,
    );

    await expectRedirectTo(connectStripeAccount(), "/reset-password");

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockAccountsCreate).not.toHaveBeenCalled();
    expect(mockAccountLinksCreate).not.toHaveBeenCalled();
  });

  it("no active recovery session: proceeds past the guard, then still fails closed (STRIPE-DISABLE-1)", async () => {
    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    expect(mockCreateClient).toHaveBeenCalled();
    expect(mockAccountsCreate).not.toHaveBeenCalled();
  });
});

// AUTH-1C: openStripeExpressDashboard()'s first-ever test coverage
// (explicitly out of scope for the earlier LAUNCH-1 P2-1 turn -- see
// this file's own top comment). Deliberately narrow: only the new
// recovery guard and the pre-existing happy-path/no-account behavior,
// not a general audit of the function.
describe("openStripeExpressDashboard (AUTH-1C)", () => {
  beforeEach(resetMocks);

  it("recovery-session defense-in-depth: redirects to /reset-password and never reaches Supabase or Stripe when a recovery session is active", async () => {
    mockCookieStore.get.mockImplementation((name: string) =>
      name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined,
    );

    await expectRedirectTo(openStripeExpressDashboard(), "/reset-password");

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateLoginLink).not.toHaveBeenCalled();
  });

  it("no stripe_account_id on file: redirects back to /dashboard/payouts without calling Stripe", async () => {
    mockProfileSingle.mockResolvedValue({ data: { stripe_account_id: null }, error: null });

    await expectRedirectTo(openStripeExpressDashboard(), "/dashboard/payouts");

    expect(mockCreateLoginLink).not.toHaveBeenCalled();
  });

  it("existing stripe_account_id: creates a login link and redirects to it", async () => {
    mockProfileSingle.mockResolvedValue({
      data: { stripe_account_id: "acct_existing" },
      error: null,
    });
    mockCreateLoginLink.mockResolvedValue({ url: "https://connect.stripe.com/express/acct_existing" });

    await expectRedirectTo(
      openStripeExpressDashboard(),
      "https://connect.stripe.com/express/acct_existing",
    );

    expect(mockCreateLoginLink).toHaveBeenCalledWith("acct_existing");
  });
});

// APP A CORRECTION 2: openStripeExpressDashboard makes a real outbound
// Stripe call (accounts.createLoginLink) -- proves the maintenance gate
// rejects before the recovery-session cookie read, any Supabase call,
// getStripe() itself, and accounts.createLoginLink. connectStripeAccount
// is deliberately left ungated (see actions.ts's own STRIPE-DISABLE-1
// comment): it is already unconditionally disabled before any profile
// read or Stripe call of any kind (see "never reads the author's
// profile at all" above), so it performs no mutation or provider call
// for a maintenance gate to guard.
describe("openStripeExpressDashboard: maintenance-mode gate (APP A CORRECTION 2)", () => {
  beforeEach(() => {
    resetMocks();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("redirects with the maintenance message before the recovery-session cookie read, Supabase, getStripe(), or createLoginLink", async () => {
    await expectRedirectTo(openStripeExpressDashboard(), "/dashboard/payouts?error=");

    expect(mockCookieStore.get).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockGetStripe).not.toHaveBeenCalled();
    expect(mockCreateLoginLink).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves the existing recovery-session check", async () => {
    vi.unstubAllEnvs();
    mockCookieStore.get.mockImplementation((name: string) =>
      name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined,
    );

    await expectRedirectTo(openStripeExpressDashboard(), "/reset-password");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});
