import type Stripe from "stripe";

// LIBRUM 2.0 CONNECT-HARDEN-1: closes the production incident where a
// stored profiles.stripe_account_id created under a different Stripe
// platform key (or a different mode -- test vs live) was passed straight
// into payment_intent_data.transfer_data.destination, producing an
// opaque Stripe "No such destination" 400 at checkout time. Every
// checkout path (buyBook, buyBundle) and the Connect onboarding action
// (connectStripeAccount) now go through the functions in this module
// instead of trusting a stored id or the profiles.stripe_payouts_enabled
// cache directly.

// Minimal Stripe client shape needed here -- same Pick<Stripe, ...>
// testability pattern already used throughout
// src/app/api/webhooks/stripe/route.ts (e.g.
// StripeDisputeVerificationClient), so a fake { accounts: { retrieve } }
// object is enough to unit test every function below without a real
// Stripe client.
export type StripeAccountRetrieveClient = Pick<Stripe, "accounts">;

export const BOOK_CHECKOUT_UNAVAILABLE_MESSAGE =
  "This book isn't available for purchase right now";
export const BUNDLE_CHECKOUT_UNAVAILABLE_MESSAGE =
  "This bundle isn't available for purchase right now";

// LIBRUM 2.0 CONNECT-HARDEN-1 REVIEW CORRECTION: the single rule for
// "can this connected account actually receive destination-charge
// proceeds and eventually be paid out" -- shared by BOTH the checkout
// gate below and the account.updated sync (src/app/api/webhooks/stripe/
// route.ts's processAccountUpdatedEvent), so this is the one place this
// business rule is ever expressed.
//
// Librum's charge is always created on the PLATFORM account (see
// stripe.checkout.sessions.create() in buyBook/buyBundle) -- the
// connected account is only ever used as payment_intent_data.
// transfer_data.destination, never as the party that creates a charge on
// itself. That makes exactly two Stripe account fields operationally
// relevant to Librum's actual money path, per the installed Stripe SDK's
// own field documentation (node_modules/stripe/cjs/resources/
// Accounts.d.ts):
//   1. capabilities.transfers === "active" -- "whether the platform can
//      transfer funds TO this account" is what actually governs whether
//      transfer_data.destination succeeds at checkout time.
//   2. payouts_enabled === true -- "whether the funds in this account
//      can be paid out" is what governs whether that balance can ever
//      reach the author's bank once it arrives.
// charges_enabled ("whether the account can process charges") describes
// a capability Librum's architecture never exercises on the connected
// account -- it never creates a charge there, only a transfer -- so it
// is deliberately NOT part of this gate, even though
// connectStripeAccount() (dashboard/payouts/actions.ts) still requests
// the card_payments capability alongside transfers at connect time (a
// separate, still-valid product decision about what the Connect
// onboarding flow collects, unrelated to what this predicate checks).
// details_submitted is also deliberately NOT part of this gate -- Stripe
// documents it as "the business has submitted its details for review,"
// not proof those details were accepted; an account can have
// details_submitted = true while still under review with both fields
// below false. It's surfaced in the failure detail purely for operator
// diagnosis, never as a pass/fail input to this function.
export function isConnectedAccountPayoutReady(
  account: Pick<Stripe.Account, "payouts_enabled" | "capabilities">,
): boolean {
  return account.payouts_enabled === true && account.capabilities?.transfers === "active";
}

export type ConnectAccountRetrieval =
  | { ok: true; account: Stripe.Account }
  | { ok: false; reason: "missing" | "stripe_error"; detail: string };

// Retrieves live state for one connected account under the CURRENT
// platform Stripe client. An id that is well-formed and stored, but was
// created under a different platform key or Stripe mode, resolves here
// as reason: "missing" (Stripe's own resource_missing error code) --
// never as a thrown exception a caller could forget to catch.
export async function retrieveConnectedAccount(
  stripeClient: StripeAccountRetrieveClient,
  accountId: string,
): Promise<ConnectAccountRetrieval> {
  try {
    const account = await stripeClient.accounts.retrieve(accountId);
    return { ok: true, account };
  } catch (error) {
    const stripeError = error as { code?: string; message?: string };
    if (stripeError.code === "resource_missing") {
      return {
        ok: false,
        reason: "missing",
        detail: stripeError.message ?? "resource_missing",
      };
    }
    return {
      ok: false,
      reason: "stripe_error",
      detail: stripeError.message ?? String(error),
    };
  }
}

export type ConnectAccountCheckResult =
  | { ok: true }
  | {
      ok: false;
      reason: "no_account" | "missing" | "not_ready" | "stripe_error";
      detail: string;
    };

// The one gate every checkout path (book, bundle) must pass before it is
// allowed to reach stripe.checkout.sessions.create() with this account id
// as payment_intent_data.transfer_data.destination. Never trusts
// profiles.stripe_payouts_enabled alone -- that column is a
// webhook-synchronized cache (see processAccountUpdatedEvent in
// src/app/api/webhooks/stripe/route.ts), not a live guarantee, and
// trusting it alone is exactly what let a stale/wrong-platform/test-mode
// account reach Stripe unvalidated before this change.
export async function checkConnectedAccountReadyForCheckout(
  stripeClient: StripeAccountRetrieveClient,
  accountId: string | null | undefined,
): Promise<ConnectAccountCheckResult> {
  if (!accountId) {
    return { ok: false, reason: "no_account", detail: "no stripe_account_id on file" };
  }

  const retrieval = await retrieveConnectedAccount(stripeClient, accountId);
  if (!retrieval.ok) {
    return retrieval;
  }

  if (!isConnectedAccountPayoutReady(retrieval.account)) {
    return {
      ok: false,
      reason: "not_ready",
      detail:
        `payouts_enabled=${retrieval.account.payouts_enabled} ` +
        `capabilities.transfers=${retrieval.account.capabilities?.transfers} ` +
        `charges_enabled=${retrieval.account.charges_enabled} ` +
        `details_submitted=${retrieval.account.details_submitted}`,
    };
  }

  return { ok: true };
}
