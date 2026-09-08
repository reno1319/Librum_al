// Pure logic extracted from buyBook (src/app/books/[id]/actions.ts) so it
// can be unit tested directly -- actions.ts has "use server" at the top,
// which (per Next.js's rules for that directive) can only export async
// functions, so this sync helper has to live outside it.

import type Stripe from "stripe";
import { platformFeeCents } from "@/lib/pricing";

// LAUNCH-1 P1-4: converts create_book_checkout_intent's own
// database expires_at (a timestamptz, sub-second precision) into the
// Unix-seconds integer Stripe's checkout.sessions.create expects.
//
// Math.floor, never Math.round -- this is the entire mechanism behind
// the proved invariant stripe_expires_at <= database_intent_reuse_cutoff
// (the intent's own expires_at, which the reuse query in
// create_book_checkout_intent compares against with `expires_at > now()`).
// Flooring a timestamp can only move it earlier or leave it unchanged
// (equal only in the measure-zero case the input lands exactly on a
// whole second) -- it can never produce a value LATER than the true
// instant. Math.round would violate the invariant for any input whose
// fractional second is >= 0.5: Stripe's session would then stay payable
// up to ~999ms after the database had already stopped reusing that
// intent. Mirrors the same Math.floor(ms / 1000) pattern already
// established in buyBundle for bundle_checkout_snapshots.protection_expires_at
// -- deliberately NOT extracted into a shared helper with that existing,
// already-audited code, to keep this change scoped to the single-book
// path only.
export function toStripeExpiresAtSeconds(expiresAtIso: string): number {
  return Math.floor(Date.parse(expiresAtIso) / 1000);
}

// STRIPE-CUTOVER-2A Section 6: pure builder for the CURRENT legacy
// checkout.sessions.create() params, extracted verbatim from buyBook's
// existing call (byte-identical field values/shape) so regime branching
// in buyBook can call one of two builders instead of duplicating the
// Stripe param object inline, without changing a single legacy field.
export type LegacyBookCheckoutSessionInput = {
  bookId: string;
  bookTitle: string;
  priceCentsAtCheckout: number;
  authorStripeAccountId: string;
  expiresAtSeconds: number;
  origin: string;
  intentId: string;
};

export function buildLegacyBookCheckoutSessionParams(
  input: LegacyBookCheckoutSessionInput,
): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: input.bookTitle },
          unit_amount: input.priceCentsAtCheckout,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: platformFeeCents(input.priceCentsAtCheckout),
      transfer_data: {
        destination: input.authorStripeAccountId,
      },
    },
    expires_at: input.expiresAtSeconds,
    success_url: `${input.origin}/books/${input.bookId}?purchase=success`,
    cancel_url: `${input.origin}/books/${input.bookId}?purchase=cancelled`,
    metadata: {
      intent_id: input.intentId,
    },
  };
}

// STRIPE-CUTOVER-2A Section 7/8: the ledger_v1 TEST-mode counterpart.
// Deliberately has NO payment_intent_data at all -- no
// transfer_data.destination, no application_fee_amount, no Stripe
// Connect/author-account dependency of any kind. Librum/platform
// receives the full buyer charge directly; author liability is created
// only by migration 056's finalize_ledger_book_payment(), never by a
// Stripe transfer. currency is the literal "all" (Section 8 -- no FX, no
// USD conversion), and unit_amount is the frozen intent's own
// price_cents_at_checkout used DIRECTLY as internal two-decimal minor
// units -- never divided by 100, and MIN_CHARGE_CENTS (a USD-cents
// business rule) is never referenced here.
//
// STRIPE-CUTOVER-2A.1 Section 3: payment_method_types is explicitly
// pinned to ["card"] -- checkout.session.completed is NOT universal
// proof of payment success for every Stripe payment method; delayed/
// asynchronous methods fire it while Checkout Session.payment_status is
// still 'unpaid', with the real outcome arriving later via
// checkout.session.async_payment_succeeded/_failed, which this Stage-2
// TEST harness deliberately does not implement. Restricting checkout
// CREATION to card (which never has an asynchronous settlement path)
// removes that gap by construction, rather than by webhook-side
// guesswork. The legacy builder above is untouched -- it keeps Stripe's
// existing default payment-method behavior exactly as before.
export type LedgerBookCheckoutSessionInput = {
  bookId: string;
  bookTitle: string;
  priceMinorUnitsAtCheckout: number;
  expiresAtSeconds: number;
  origin: string;
  intentId: string;
};

export function buildLedgerBookCheckoutSessionParams(
  input: LedgerBookCheckoutSessionInput,
): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "all",
          product_data: { name: input.bookTitle },
          unit_amount: input.priceMinorUnitsAtCheckout,
        },
        quantity: 1,
      },
    ],
    expires_at: input.expiresAtSeconds,
    success_url: `${input.origin}/books/${input.bookId}?purchase=success`,
    cancel_url: `${input.origin}/books/${input.bookId}?purchase=cancelled`,
    metadata: {
      intent_id: input.intentId,
    },
  };
}
