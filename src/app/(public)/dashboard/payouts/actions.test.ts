import { describe, expect, it, vi, beforeEach } from "vitest";
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
vi.mock("@/lib/stripe", () => ({
  stripe: {
    accounts: {
      create: (...args: unknown[]) => mockAccountsCreate(...args),
      retrieve: (...args: unknown[]) => mockAccountsRetrieve(...args),
      createLoginLink: (...args: unknown[]) => mockCreateLoginLink(...args),
    },
    accountLinks: { create: (...args: unknown[]) => mockAccountLinksCreate(...args) },
  },
}));

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

describe("connectStripeAccount", () => {
  beforeEach(resetMocks);

  it("1. profile read error: never calls accounts.create or accountLinks.create, redirects to a generic failure", async () => {
    mockProfileSingle.mockResolvedValue({ data: null, error: { message: "connection reset" } });

    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    expect(mockAccountsCreate).not.toHaveBeenCalled();
    expect(mockAccountLinksCreate).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
  });

  it("2. existing stripe_account_id: skips accounts.create, accountLinks.create uses the existing id", async () => {
    mockProfileSingle.mockResolvedValue({
      data: { stripe_account_id: "acct_existing" },
      error: null,
    });

    await expectRedirectTo(connectStripeAccount(), "https://connect.stripe.com/setup/acct_new");

    expect(mockAccountsCreate).not.toHaveBeenCalled();
    expect(mockAccountLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({ account: "acct_existing" }),
    );
  });

  it("3. new account: accounts.create receives metadata.librum_user_id and a deterministic idempotency key", async () => {
    await expectRedirectTo(connectStripeAccount(), "https://connect.stripe.com/setup/acct_new");

    expect(mockAccountsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { librum_user_id: USER_ID } }),
      expect.objectContaining({ idempotencyKey: expect.stringContaining(USER_ID) }),
    );
  });

  it("4. successful creation + verified persistence: Account Link created with the persisted id", async () => {
    await expectRedirectTo(connectStripeAccount(), "https://connect.stripe.com/setup/acct_new");

    expect(mockAccountLinksCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ account: "acct_new" }),
    );
  });

  it("5. DB update returns an error: no Account Link, fails safely, logs correlation info", async () => {
    mockAdminUpdateSelect.mockResolvedValue({ data: null, error: { message: "write failed" } });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    expect(mockAccountLinksCreate).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to persist"),
      expect.objectContaining({ userId: USER_ID, newlyCreatedStripeAccountId: "acct_new" }),
    );
    errorSpy.mockRestore();
  });

  it("6. zero-row update: triggers a re-read", async () => {
    mockAdminUpdateSelect.mockResolvedValue({ data: [], error: null });
    mockAdminReReadMaybeSingle.mockResolvedValue({
      data: { stripe_account_id: "acct_new" },
      error: null,
    });

    await expectRedirectTo(connectStripeAccount(), "https://connect.stripe.com/setup/acct_new");

    expect(mockAdminReReadMaybeSingle).toHaveBeenCalledOnce();
  });

  it("7. zero-row update + re-read returns the same id: converges, Account Link created once", async () => {
    mockAdminUpdateSelect.mockResolvedValue({ data: [], error: null });
    mockAdminReReadMaybeSingle.mockResolvedValue({
      data: { stripe_account_id: "acct_new" },
      error: null,
    });

    await expectRedirectTo(connectStripeAccount(), "https://connect.stripe.com/setup/acct_new");

    expect(mockAccountLinksCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ account: "acct_new" }),
    );
  });

  it("8. zero-row update + re-read returns a different existing id: the existing DB id wins, orphan logged", async () => {
    mockAdminUpdateSelect.mockResolvedValue({ data: [], error: null });
    mockAdminReReadMaybeSingle.mockResolvedValue({
      data: { stripe_account_id: "acct_existing_other" },
      error: null,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expectRedirectTo(
      connectStripeAccount(),
      "https://connect.stripe.com/setup/acct_new", // resolved value is unconditional in this fixture
    );

    expect(mockAccountLinksCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ account: "acct_existing_other" }),
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("orphan"),
      expect.objectContaining({
        userId: USER_ID,
        newlyCreatedStripeAccountId: "acct_new",
        canonicalStripeAccountId: "acct_existing_other",
      }),
    );
    errorSpy.mockRestore();
  });

  it("9. zero-row update + re-read still null: fails safely, no Account Link", async () => {
    mockAdminUpdateSelect.mockResolvedValue({ data: [], error: null });
    mockAdminReReadMaybeSingle.mockResolvedValue({
      data: { stripe_account_id: null },
      error: null,
    });

    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    expect(mockAccountLinksCreate).not.toHaveBeenCalled();
  });

  it("10. accounts.create throws: no DB persistence attempt, no Account Link", async () => {
    mockAccountsCreate.mockRejectedValue(new Error("Stripe is down"));

    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockAdminUpdateSelect).not.toHaveBeenCalled();
    expect(mockAccountLinksCreate).not.toHaveBeenCalled();
  });

  it("11. accountLinks.create throws after persistence: the persisted account stays canonical, no second account is created in this invocation", async () => {
    mockAccountLinksCreate.mockRejectedValue(new Error("link creation failed"));

    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    expect(mockAccountsCreate).toHaveBeenCalledOnce();
  });

  it("12. the same user gets the same deterministic idempotency key across retries", async () => {
    await expectRedirectTo(connectStripeAccount(), "https://connect.stripe.com/setup/acct_new");
    const firstKey = mockAccountsCreate.mock.calls[0][1].idempotencyKey;

    mockAccountsCreate.mockClear();
    mockAdminUpdateSelect.mockResolvedValue({ data: [], error: null });
    mockAdminReReadMaybeSingle.mockResolvedValue({
      data: { stripe_account_id: "acct_new" },
      error: null,
    });
    await expectRedirectTo(connectStripeAccount(), "https://connect.stripe.com/setup/acct_new");
    const secondKey = mockAccountsCreate.mock.calls[0][1].idempotencyKey;

    expect(secondKey).toBe(firstKey);
  });

  it("13. different users get different idempotency keys", async () => {
    await expectRedirectTo(connectStripeAccount(), "https://connect.stripe.com/setup/acct_new");
    const firstKey = mockAccountsCreate.mock.calls[0][1].idempotencyKey;

    mockAccountsCreate.mockClear();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-2", email: "c@d.co" } } });
    await expectRedirectTo(connectStripeAccount(), "https://connect.stripe.com/setup/acct_new");
    const secondKey = mockAccountsCreate.mock.calls[0][1].idempotencyKey;

    expect(secondKey).not.toBe(firstKey);
  });

  it("15. LIBRUM 2.0 CONNECT-HARDEN-1: existing account resolves resource_missing under the current platform -- reconnect-required redirect, id NOT auto-cleared, never reaches accountLinks.create", async () => {
    mockProfileSingle.mockResolvedValue({
      data: { stripe_account_id: "acct_stale_other_platform" },
      error: null,
    });
    const stripeError = Object.assign(
      new Error(
        "No such destination: 'acct_stale_other_platform'; a similar object exists in test mode, but a live mode key was used to make this request.",
      ),
      { code: "resource_missing" },
    );
    mockAccountsRetrieve.mockRejectedValue(stripeError);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expectRedirectTo(connectStripeAccount(), "reconnected");

    expect(mockAccountsCreate).not.toHaveBeenCalled();
    expect(mockAccountLinksCreate).not.toHaveBeenCalled();
    // Never writes to the admin client from this branch -- the stored id
    // is deliberately left exactly as it was; only an explicit operator
    // reset (the same workflow already used for Renato Kalemi's account)
    // clears it.
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    // The real Stripe reason IS expected here -- server-side logging is
    // explicitly where the operational detail belongs (see requirement
    // 4's "continue logging the real operational error server-side").
    // What must never leak is the BUYER/author-facing redirect, checked
    // separately below.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("NOT auto-cleared"),
      expect.objectContaining({
        stripeAccountId: "acct_stale_other_platform",
        detail: expect.stringContaining("test mode"),
      }),
    );

    const redirectedUrl = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedUrl).not.toContain("acct_");
    expect(redirectedUrl).not.toContain("test mode");
    errorSpy.mockRestore();
  });

  it("16. LIBRUM 2.0 CONNECT-HARDEN-1: existing account lookup fails with a transient Stripe error -- generic retryable failure, never reaches accountLinks.create", async () => {
    mockProfileSingle.mockResolvedValue({
      data: { stripe_account_id: "acct_existing" },
      error: null,
    });
    mockAccountsRetrieve.mockRejectedValue(new Error("Stripe is temporarily unavailable"));

    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    expect(mockAccountLinksCreate).not.toHaveBeenCalled();
  });

  it("17. LIBRUM 2.0 CONNECT-HARDEN-1: a freshly-created account is always retrieved and passes -- Account Link still created normally", async () => {
    await expectRedirectTo(connectStripeAccount(), "https://connect.stripe.com/setup/acct_new");

    expect(mockAccountsRetrieve).toHaveBeenCalledWith("acct_new");
    expect(mockAccountLinksCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ account: "acct_new" }),
    );
  });

  it("14. no secret values appear in operational log payloads", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const forbidden = ["sk_test_", "sk_live_", "service_role", "access_token", "cookie"];

    mockProfileSingle.mockResolvedValue({ data: null, error: { message: "db error" } });
    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    resetMocks();
    errorSpy.mockClear();
    mockAdminUpdateSelect.mockResolvedValue({ data: null, error: { message: "write failed" } });
    await expectRedirectTo(connectStripeAccount(), GENERIC_FAILURE);

    const serialized = JSON.stringify(errorSpy.mock.calls).toLowerCase();
    for (const secret of forbidden) {
      expect(serialized).not.toContain(secret);
    }
    errorSpy.mockRestore();
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

  it("no active recovery session: proceeds past the guard exactly as before this pass", async () => {
    await expectRedirectTo(connectStripeAccount(), "https://connect.stripe.com/setup/acct_new");

    expect(mockCreateClient).toHaveBeenCalled();
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
