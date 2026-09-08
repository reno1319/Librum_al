import { describe, expect, it } from "vitest";
import {
  buildLegacyBundleCheckoutSessionParams,
  buildLedgerBundleCheckoutSessionParams,
} from "./checkout-logic";
import { platformFeeCents, MIN_CHARGE_CENTS } from "@/lib/pricing";

// STRIPE-CUTOVER-2A Section 33: bundle equivalent of the single-book
// builder tests -- legacy unchanged, ledger has no Connect semantics and
// full-platform-charge economics.
describe("buildLegacyBundleCheckoutSessionParams", () => {
  const baseInput = {
    bundleId: "bundle-1",
    bundleTitle: "Test Bundle",
    bundlePriceCentsAtCheckout: 1999,
    authorStripeAccountId: "acct_author1",
    expiresAtSeconds: 1_700_000_000,
    origin: "https://librum.al",
    snapshotId: "snapshot-1",
  };

  it("currency is USD", () => {
    const params = buildLegacyBundleCheckoutSessionParams(baseInput);
    expect(params.line_items?.[0].price_data?.currency).toBe("usd");
  });

  it("unit_amount is the frozen bundle_price_cents_at_checkout, unmodified", () => {
    const params = buildLegacyBundleCheckoutSessionParams(baseInput);
    expect(params.line_items?.[0].price_data?.unit_amount).toBe(1999);
  });

  it("includes payment_intent_data with Connect destination transfer and application fee", () => {
    const params = buildLegacyBundleCheckoutSessionParams(baseInput);
    expect(params.payment_intent_data?.transfer_data?.destination).toBe("acct_author1");
    expect(params.payment_intent_data?.application_fee_amount).toBe(platformFeeCents(1999));
  });

  it("metadata carries snapshot_id and bundle_id", () => {
    const params = buildLegacyBundleCheckoutSessionParams(baseInput);
    expect(params.metadata).toEqual({ snapshot_id: "snapshot-1", bundle_id: "bundle-1" });
  });

  it("does not restrict payment_method_types -- unchanged Stripe default behavior", () => {
    const params = buildLegacyBundleCheckoutSessionParams(baseInput);
    expect(params.payment_method_types).toBeUndefined();
  });
});

describe("buildLedgerBundleCheckoutSessionParams", () => {
  const baseInput = {
    bundleId: "bundle-1",
    bundleTitle: "Test Bundle",
    bundlePriceMinorUnitsAtCheckout: 250000,
    expiresAtSeconds: 1_700_000_000,
    origin: "https://librum.al",
    snapshotId: "snapshot-2",
  };

  it("currency is the literal lowercase all", () => {
    const params = buildLedgerBundleCheckoutSessionParams(baseInput);
    expect(params.line_items?.[0].price_data?.currency).toBe("all");
  });

  it("unit_amount uses internal minor units directly -- no /100, no FX", () => {
    const params = buildLedgerBundleCheckoutSessionParams(baseInput);
    expect(params.line_items?.[0].price_data?.unit_amount).toBe(250000);
  });

  it("never reuses MIN_CHARGE_CENTS as an ALL business rule", () => {
    const params = buildLedgerBundleCheckoutSessionParams({
      ...baseInput,
      bundlePriceMinorUnitsAtCheckout: 5,
    });
    expect(params.line_items?.[0].price_data?.unit_amount).toBe(5);
    expect(params.line_items?.[0].price_data?.unit_amount).not.toBe(MIN_CHARGE_CENTS);
  });

  it("has NO payment_intent_data at all -- no Connect destination, no application fee", () => {
    const params = buildLedgerBundleCheckoutSessionParams(baseInput);
    expect(params.payment_intent_data).toBeUndefined();
  });

  it("restricts payment_method_types to card only (STRIPE-CUTOVER-2A.1 Section 3) -- no asynchronous settlement path", () => {
    const params = buildLedgerBundleCheckoutSessionParams(baseInput);
    expect(params.payment_method_types).toEqual(["card"]);
  });

  it("metadata carries snapshot_id and bundle_id -- no authoritative financial facts", () => {
    const params = buildLedgerBundleCheckoutSessionParams(baseInput);
    expect(params.metadata).toEqual({ snapshot_id: "snapshot-2", bundle_id: "bundle-1" });
  });
});
