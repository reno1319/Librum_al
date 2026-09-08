import type Stripe from "stripe";

// STRIPE-CUTOVER-2A.1 Section 2-7: migration 056's ledger_v1 finalizers
// require GENUINE provider-confirmed proof of payment success -- not
// merely the fact that a checkout.session.completed event fired.
// checkout.session.completed is NOT universal proof of payment success:
// Stripe fires it for delayed/asynchronous payment methods even while
// Checkout Session.payment_status is still 'unpaid', and the true
// outcome only arrives later via checkout.session.async_payment_
// succeeded/_failed. This Stage-2 TEST harness deliberately does not
// implement that async event pair (Section 3, option A) -- instead,
// checkout creation restricts ledger_v1 sessions to synchronous card
// payments only (payment_method_types: ["card"], see checkout-logic.ts
// in both books/[id] and bundles/[id]), which by construction never has
// an asynchronous settlement path. This adapter is the second,
// independent layer of proof: it retrieves the PaymentIntent (and its
// expanded latest_charge) directly from Stripe and verifies genuine
// success before returning ANY fact a finalizer could act on.
//
// Every fact this adapter returns is provider-CONFIRMED, never a
// Librum-expected value: actualAmountMinor is the CHARGE's own
// amount_captured (falling back to PaymentIntent.amount_received only
// if no charge is attached to an otherwise-succeeded PaymentIntent --
// both are Stripe's own record of what was ACTUALLY collected, never
// session.amount_total, which merely describes what the session asked
// for). actualCurrency is read the same way. paidAt is the successful
// Charge's own `created` timestamp (Stripe documents this as the
// Charge object's creation time -- for a synchronous card charge that
// creation happens at the moment the charge succeeds, so it is accurate
// to call it "the successful charge's own provider timestamp," not a
// universal "payment succeeded instant" claim that would overclaim for
// any payment method with a delayed settlement path).
export type StripePaymentIntentRetrieveClient = Pick<Stripe, "paymentIntents">;

export type StripeLedgerPaymentFacts =
  | {
      ok: true;
      paidAt: Date;
      actualAmountMinor: number;
      actualCurrency: string;
    }
  | { ok: false; reason: string };

export async function retrieveStripeLedgerPaymentFacts(
  stripeClient: StripePaymentIntentRetrieveClient,
  paymentIntentId: string,
): Promise<StripeLedgerPaymentFacts> {
  const paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntentId, {
    expand: ["latest_charge"],
  });

  // The primary success proof: Stripe's own PaymentIntent.status. A
  // value other than 'succeeded' (e.g. 'processing', 'requires_action',
  // 'requires_payment_method') means this specific delivery has NOT yet
  // proven a completed payment, regardless of the checkout.session.
  // completed event having fired -- must not finalize, must not even
  // record the event as processed commerce; the caller fails the
  // webhook so Stripe retries once the true outcome is known.
  if (paymentIntent.status !== "succeeded") {
    return {
      ok: false,
      reason: `PaymentIntent.status is "${paymentIntent.status}", not "succeeded"`,
    };
  }

  const charge =
    paymentIntent.latest_charge && typeof paymentIntent.latest_charge === "object"
      ? paymentIntent.latest_charge
      : null;

  // A succeeded PaymentIntent with an attached charge must have a
  // genuinely successful, paid charge -- consistency between the two
  // provider objects is itself part of the success proof (Section 4).
  // Stripe's own SDK types Charge.status as a plain `string`, not a
  // closed union (new values can appear), so an unrecognized status is
  // treated the same as a failed one -- fail closed, never assume an
  // unrecognized value is safe.
  if (charge && (charge.status !== "succeeded" || !charge.paid)) {
    return {
      ok: false,
      reason: `latest_charge is not a successful, paid charge (status="${charge.status}", paid=${charge.paid})`,
    };
  }

  // Provider-confirmed ACTUAL amount -- Charge.amount_captured when a
  // charge is attached (the specific charge's own captured total),
  // falling back to PaymentIntent.amount_received only for the
  // (anomalous, but not assumed impossible) case of a succeeded
  // PaymentIntent with no expanded charge. NEVER session.amount_total or
  // any other Librum-expected value -- this is the exact substitution
  // Section 5 prohibits.
  const actualAmountMinor = charge?.amount_captured ?? paymentIntent.amount_received;
  if (typeof actualAmountMinor !== "number" || !Number.isFinite(actualAmountMinor) || actualAmountMinor <= 0) {
    return { ok: false, reason: "no usable actual captured/received amount on the successful payment" };
  }

  // Provider-confirmed ACTUAL currency -- same charge-first, PaymentIntent-
  // fallback pattern. Never synthesized as "ALL" merely because the DB
  // wrapper expects it (Section 6) -- a genuine mismatch here is passed
  // through as-is and left to the DB wrapper's own hard actual-vs-
  // expected match to reject.
  const actualCurrency = charge?.currency ?? paymentIntent.currency;
  if (typeof actualCurrency !== "string" || actualCurrency.length === 0) {
    return { ok: false, reason: "no usable actual currency on the successful payment" };
  }

  // paidAt -- see this file's own top comment for the precise, corrected
  // claim: the successful Charge's own provider creation timestamp (or,
  // absent an attached charge, the succeeded PaymentIntent's own
  // creation timestamp), not a universal payment-success instant.
  const unixSeconds = charge?.created ?? paymentIntent.created;
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) {
    return { ok: false, reason: "no usable paid_at timestamp on the successful payment" };
  }

  return {
    ok: true,
    paidAt: new Date(unixSeconds * 1000),
    actualAmountMinor,
    actualCurrency,
  };
}
