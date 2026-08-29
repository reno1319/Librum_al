import { describe, expect, it, vi, beforeEach } from "vitest";

// LAUNCH-1 P2-1: connectStripeAccount() get-or-creates a Stripe Connect
// Express account and persists its id onto the author's own profiles
// row. This file covers the persistence-hardening logic added in that
// turn -- the profile-read failure guard, the deterministic idempotency
// key, the conditional (WHERE stripe_account_id IS NULL) persistence
// write and its zero-row/conflicting-account reconciliation branch, and
// the Account Link failure behavior -- not Stripe/Supabase's own
// pre-existing semantics. openStripeExpressDashboard() is out of scope
// for this turn and is not covered here.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

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
const mockAccountLinksCreate = vi.fn();
vi.mock("@/lib/stripe", () => ({
  stripe: {
    accounts: { create: (...args: unknown[]) => mockAccountsCreate(...args) },
    accountLinks: { create: (...args: unknown[]) => mockAccountLinksCreate(...args) },
  },
}));

const { connectStripeAccount } = await import("./actions");

const USER_ID = "user-1";

function resetMocks() {
  mockRedirect.mockClear();
  mockCreateClient.mockClear();
  mockCreateAdminClient.mockClear();

  mockGetUser.mockReset().mockResolvedValue({ data: { user: { id: USER_ID, email: "a@b.co" } } });
  mockProfileSingle.mockReset().mockResolvedValue({ data: { stripe_account_id: null }, error: null });
  mockAdminUpdateSelect
    .mockReset()
    .mockResolvedValue({ data: [{ stripe_account_id: "acct_new" }], error: null });
  mockAdminReReadMaybeSingle.mockReset().mockResolvedValue({ data: null, error: null });
  mockAccountsCreate.mockReset().mockResolvedValue({ id: "acct_new" });
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
