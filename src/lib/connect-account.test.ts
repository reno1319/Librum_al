import { describe, expect, it, vi } from "vitest";
import {
  isConnectedAccountPayoutReady,
  retrieveConnectedAccount,
  checkConnectedAccountReadyForCheckout,
  BOOK_CHECKOUT_UNAVAILABLE_MESSAGE,
  BUNDLE_CHECKOUT_UNAVAILABLE_MESSAGE,
  type StripeAccountRetrieveClient,
} from "./connect-account";

// LIBRUM 2.0 CONNECT-HARDEN-1: the production incident this module
// exists to prevent -- profiles.stripe_account_id created under a
// different Stripe platform key (or mode) was passed straight into
// payment_intent_data.transfer_data.destination, producing Stripe's own
// "No such destination: 'acct_...'; a similar object exists in test
// mode, but a live mode key was used to make this request." Every case
// below is a direct regression test for one specific way that can
// happen, or for the readiness rule itself.

function makeAccount(overrides: {
  charges_enabled?: boolean;
  payouts_enabled?: boolean;
  details_submitted?: boolean;
  transfers?: "active" | "inactive" | "pending" | undefined;
  omitTransfersKey?: boolean;
} = {}) {
  const { transfers, omitTransfersKey, ...rest } = overrides;
  return {
    id: "acct_test",
    charges_enabled: true,
    payouts_enabled: true,
    details_submitted: true,
    capabilities: omitTransfersKey ? {} : { transfers: transfers ?? "active" },
    ...rest,
  } as never;
}

function makeStripeClient(params: {
  account?: ReturnType<typeof makeAccount>;
  error?: { code?: string; message?: string };
}) {
  const retrieve = vi.fn(() => {
    if (params.error) return Promise.reject(params.error);
    return Promise.resolve(params.account);
  });
  return { accounts: { retrieve } } as unknown as StripeAccountRetrieveClient & {
    accounts: { retrieve: typeof retrieve };
  };
}

// LIBRUM 2.0 CONNECT-HARDEN-1 REVIEW CORRECTION: predicate changed from
// (charges_enabled && payouts_enabled) to
// (payouts_enabled && capabilities.transfers === "active") -- Librum's
// destination-charge architecture never creates a charge ON the
// connected account (that always happens on the platform), so
// charges_enabled is not part of Librum's actual money-path requirement.
// Every case below is the exact matrix specified for this correction.
describe("isConnectedAccountPayoutReady", () => {
  it("payouts_enabled=true + transfers=active: ready", () => {
    expect(
      isConnectedAccountPayoutReady(makeAccount({ payouts_enabled: true, transfers: "active" })),
    ).toBe(true);
  });

  it("payouts_enabled=false + transfers=active: not ready", () => {
    expect(
      isConnectedAccountPayoutReady(makeAccount({ payouts_enabled: false, transfers: "active" })),
    ).toBe(false);
  });

  it("payouts_enabled=true + transfers=pending: not ready", () => {
    expect(
      isConnectedAccountPayoutReady(makeAccount({ payouts_enabled: true, transfers: "pending" })),
    ).toBe(false);
  });

  it("payouts_enabled=true + transfers=inactive: not ready", () => {
    expect(
      isConnectedAccountPayoutReady(makeAccount({ payouts_enabled: true, transfers: "inactive" })),
    ).toBe(false);
  });

  it("payouts_enabled=true + transfers undefined (capability not present at all): not ready", () => {
    expect(
      isConnectedAccountPayoutReady(makeAccount({ payouts_enabled: true, omitTransfersKey: true })),
    ).toBe(false);
  });

  // The specific regression this correction exists to prove: the removed
  // charges_enabled dependency stays removed. An account that is fully
  // ready to receive and pay out destination-charge proceeds must be
  // treated as ready EVEN with charges_enabled false.
  it("charges_enabled=false + payouts_enabled=true + transfers=active: READY -- charges_enabled is not part of this gate", () => {
    expect(
      isConnectedAccountPayoutReady(
        makeAccount({ charges_enabled: false, payouts_enabled: true, transfers: "active" }),
      ),
    ).toBe(true);
  });
});

describe("retrieveConnectedAccount", () => {
  it("Stripe resolves successfully: ok with the retrieved account", async () => {
    const account = makeAccount();
    const client = makeStripeClient({ account });

    const result = await retrieveConnectedAccount(client, "acct_test");

    expect(result).toEqual({ ok: true, account });
  });

  it("Stripe resource_missing (the exact production failure mode -- stale/wrong-platform/test-mode account): reason 'missing', never throws", async () => {
    const client = makeStripeClient({
      error: {
        code: "resource_missing",
        message:
          "No such destination: 'acct_1U4LsoIwnWBEg0IB'; a similar object exists in test mode, but a live mode key was used to make this request.",
      },
    });

    const result = await retrieveConnectedAccount(client, "acct_1U4LsoIwnWBEg0IB");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("missing");
  });

  it("any other Stripe/network error: reason 'stripe_error', never throws", async () => {
    const client = makeStripeClient({ error: { message: "Stripe is temporarily unavailable" } });

    const result = await retrieveConnectedAccount(client, "acct_test");

    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe("stripe_error");
  });
});

describe("checkConnectedAccountReadyForCheckout", () => {
  it("no accountId at all: reason 'no_account', never calls Stripe", async () => {
    const client = makeStripeClient({ account: makeAccount() });

    const result = await checkConnectedAccountReadyForCheckout(client, null);

    expect(result).toEqual({ ok: false, reason: "no_account", detail: expect.any(String) });
    expect(client.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("empty-string accountId: reason 'no_account', never calls Stripe", async () => {
    const client = makeStripeClient({ account: makeAccount() });

    const result = await checkConnectedAccountReadyForCheckout(client, "");

    expect(result.ok).toBe(false);
    expect(client.accounts.retrieve).not.toHaveBeenCalled();
  });

  it("Stripe resource_missing: reason 'missing'", async () => {
    const client = makeStripeClient({ error: { code: "resource_missing", message: "No such destination" } });

    const result = await checkConnectedAccountReadyForCheckout(client, "acct_stale");

    expect(result).toEqual({ ok: false, reason: "missing", detail: expect.any(String) });
  });

  it("account retrieved but payouts_enabled is false: reason 'not_ready'", async () => {
    const client = makeStripeClient({ account: makeAccount({ payouts_enabled: false }) });

    const result = await checkConnectedAccountReadyForCheckout(client, "acct_pending");

    expect(result).toEqual({ ok: false, reason: "not_ready", detail: expect.any(String) });
  });

  it("account retrieved but capabilities.transfers is not active: reason 'not_ready'", async () => {
    const client = makeStripeClient({ account: makeAccount({ transfers: "pending" }) });

    const result = await checkConnectedAccountReadyForCheckout(client, "acct_pending");

    expect(result).toEqual({ ok: false, reason: "not_ready", detail: expect.any(String) });
  });

  it("account retrieved, details_submitted false but payouts_enabled + transfers=active: still ready -- details_submitted is not gating", async () => {
    const client = makeStripeClient({ account: makeAccount({ details_submitted: false }) });

    const result = await checkConnectedAccountReadyForCheckout(client, "acct_ready");

    expect(result).toEqual({ ok: true });
  });

  // REVIEW CORRECTION regression: the removed charges_enabled dependency
  // must stay removed at this integration level too, not just at the
  // unit level.
  it("account retrieved with charges_enabled false but payouts_enabled + transfers=active: READY", async () => {
    const client = makeStripeClient({
      account: makeAccount({ charges_enabled: false, payouts_enabled: true, transfers: "active" }),
    });

    const result = await checkConnectedAccountReadyForCheckout(client, "acct_ready");

    expect(result).toEqual({ ok: true });
  });

  it("fully payout-ready account: ok", async () => {
    const client = makeStripeClient({ account: makeAccount() });

    const result = await checkConnectedAccountReadyForCheckout(client, "acct_ready");

    expect(result).toEqual({ ok: true });
  });

  it("any other Stripe error: reason 'stripe_error'", async () => {
    const client = makeStripeClient({ error: { message: "network hiccup" } });

    const result = await checkConnectedAccountReadyForCheckout(client, "acct_test");

    expect(result).toEqual({ ok: false, reason: "stripe_error", detail: expect.any(String) });
  });
});

describe("public-safe unavailability messages", () => {
  it("never mention Stripe, accounts, or platform-internal details", () => {
    for (const message of [BOOK_CHECKOUT_UNAVAILABLE_MESSAGE, BUNDLE_CHECKOUT_UNAVAILABLE_MESSAGE]) {
      expect(message.toLowerCase()).not.toContain("stripe");
      expect(message.toLowerCase()).not.toContain("acct_");
      expect(message.toLowerCase()).not.toContain("platform");
    }
  });
});
