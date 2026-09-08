// STRIPE-CUTOVER-2A: pure, testable Stripe Checkout Session param
// builders for buyBundle (src/app/(public)/bundles/[id]/actions.ts),
// split by regime -- mirrors the identical split already made for the
// single-book path (src/app/(public)/books/[id]/checkout-logic.ts). Kept
// in its own file rather than shared with the book builders: the two
// checkout shapes take structurally different inputs (bundle_title vs
// book title, no bookId/only bundleId) and this file's own comments stay
// scoped to bundle-specific reasoning.

import type Stripe from "stripe";
import { platformFeeCents } from "@/lib/pricing";

// Byte-identical to buyBundle's pre-2A inline object -- Connect
// destination transfer and application fee, USD.
export type LegacyBundleCheckoutSessionInput = {
  bundleId: string;
  bundleTitle: string;
  bundlePriceCentsAtCheckout: number;
  authorStripeAccountId: string;
  expiresAtSeconds: number;
  origin: string;
  snapshotId: string;
};

export function buildLegacyBundleCheckoutSessionParams(
  input: LegacyBundleCheckoutSessionInput,
): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: { name: input.bundleTitle },
          unit_amount: input.bundlePriceCentsAtCheckout,
        },
        quantity: 1,
      },
    ],
    payment_intent_data: {
      application_fee_amount: platformFeeCents(input.bundlePriceCentsAtCheckout),
      transfer_data: {
        destination: input.authorStripeAccountId,
      },
    },
    expires_at: input.expiresAtSeconds,
    success_url: `${input.origin}/bundles/${input.bundleId}?purchase=success`,
    cancel_url: `${input.origin}/bundles/${input.bundleId}?purchase=cancelled`,
    metadata: {
      snapshot_id: input.snapshotId,
      bundle_id: input.bundleId,
    },
  };
}

// STRIPE-CUTOVER-2A Section 10: ledger_v1 TEST-mode counterpart. No
// payment_intent_data at all (no Connect destination transfer, no
// application fee) -- Librum/platform receives the full buyer charge
// directly, author liability is created only by migration 056's
// finalize_ledger_bundle_payment(), never by a Stripe transfer. currency
// is the literal "all" (no FX), and unit_amount is the frozen snapshot's
// own bundle_price_cents_at_checkout used DIRECTLY as internal
// two-decimal minor units.
//
// STRIPE-CUTOVER-2A.1 Section 3: payment_method_types pinned to ["card"]
// for the identical reason as the single-book builder (checkout-logic.ts
// in books/[id]) -- eliminates the asynchronous-payment-method gap by
// construction, since card never has a delayed settlement path.
export type LedgerBundleCheckoutSessionInput = {
  bundleId: string;
  bundleTitle: string;
  bundlePriceMinorUnitsAtCheckout: number;
  expiresAtSeconds: number;
  origin: string;
  snapshotId: string;
};

export function buildLedgerBundleCheckoutSessionParams(
  input: LedgerBundleCheckoutSessionInput,
): Stripe.Checkout.SessionCreateParams {
  return {
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [
      {
        price_data: {
          currency: "all",
          product_data: { name: input.bundleTitle },
          unit_amount: input.bundlePriceMinorUnitsAtCheckout,
        },
        quantity: 1,
      },
    ],
    expires_at: input.expiresAtSeconds,
    success_url: `${input.origin}/bundles/${input.bundleId}?purchase=success`,
    cancel_url: `${input.origin}/bundles/${input.bundleId}?purchase=cancelled`,
    metadata: {
      snapshot_id: input.snapshotId,
      bundle_id: input.bundleId,
    },
  };
}
