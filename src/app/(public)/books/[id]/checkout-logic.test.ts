import { describe, expect, it } from "vitest";
import {
  toStripeExpiresAtSeconds,
  buildLegacyBookCheckoutSessionParams,
  buildLedgerBookCheckoutSessionParams,
} from "./checkout-logic";
import { platformFeeCents, MIN_CHARGE_CENTS } from "@/lib/pricing";

describe("toStripeExpiresAtSeconds", () => {
  it("floors a sub-second timestamp down to the previous whole second", () => {
    // 700ms into the second -- flooring must discard the fraction, not
    // round it, so the result is the START of that second, not the next
    // one.
    const seconds = toStripeExpiresAtSeconds("2026-08-24T09:00:00.700Z");
    expect(seconds).toBe(Date.parse("2026-08-24T09:00:00.000Z") / 1000);
  });

  it("proves the invariant directly: the result is never later than the true instant", () => {
    const cases = [
      "2026-08-24T09:00:00.000Z",
      "2026-08-24T09:00:00.001Z",
      "2026-08-24T09:00:00.499Z",
      "2026-08-24T09:00:00.500Z",
      "2026-08-24T09:00:00.999Z",
      "2026-01-01T00:00:00.123Z",
    ];
    for (const iso of cases) {
      const trueInstantSeconds = Date.parse(iso) / 1000;
      const result = toStripeExpiresAtSeconds(iso);
      expect(result).toBeLessThanOrEqual(trueInstantSeconds);
    }
  });

  it("would be violated by Math.round -- documents why floor, not round, is required", () => {
    const iso = "2026-08-24T09:00:00.700Z";
    const ms = Date.parse(iso);
    const floored = Math.floor(ms / 1000);
    const rounded = Math.round(ms / 1000);
    // .700 rounds UP to the next second -- strictly later than the true
    // instant, which would violate stripe_expires_at <= db cutoff.
    expect(rounded).toBeGreaterThan(ms / 1000);
    expect(floored).toBeLessThanOrEqual(ms / 1000);
    expect(toStripeExpiresAtSeconds(iso)).toBe(floored);
    expect(toStripeExpiresAtSeconds(iso)).not.toBe(rounded);
  });

  it("returns whole seconds already unchanged (the only equality case)", () => {
    const iso = "2026-08-24T09:00:00.000Z";
    expect(toStripeExpiresAtSeconds(iso)).toBe(Date.parse(iso) / 1000);
  });
});

// STRIPE-CUTOVER-2A Section 32: proves the legacy builder's Stripe
// Connect params are unchanged, and proves the ledger builder's session
// params carry no Connect/application-fee semantics at all -- the
// central double-pay-prevention invariant (Section 21/36) starts here,
// at the params Stripe itself is actually given.
describe("buildLegacyBookCheckoutSessionParams", () => {
  const baseInput = {
    bookId: "book-1",
    bookTitle: "Test Book",
    priceCentsAtCheckout: 999,
    authorStripeAccountId: "acct_author1",
    expiresAtSeconds: 1_700_000_000,
    origin: "https://librum.al",
    intentId: "intent-1",
  };

  it("currency is USD", () => {
    const params = buildLegacyBookCheckoutSessionParams(baseInput);
    expect(params.line_items?.[0].price_data?.currency).toBe("usd");
  });

  it("unit_amount is the frozen price_cents_at_checkout, unmodified", () => {
    const params = buildLegacyBookCheckoutSessionParams(baseInput);
    expect(params.line_items?.[0].price_data?.unit_amount).toBe(999);
  });

  it("includes payment_intent_data with Connect destination transfer and application fee", () => {
    const params = buildLegacyBookCheckoutSessionParams(baseInput);
    expect(params.payment_intent_data?.transfer_data?.destination).toBe("acct_author1");
    expect(params.payment_intent_data?.application_fee_amount).toBe(platformFeeCents(999));
  });

  it("metadata carries only intent_id", () => {
    const params = buildLegacyBookCheckoutSessionParams(baseInput);
    expect(params.metadata).toEqual({ intent_id: "intent-1" });
  });

  it("does not restrict payment_method_types -- unchanged Stripe default behavior", () => {
    const params = buildLegacyBookCheckoutSessionParams(baseInput);
    expect(params.payment_method_types).toBeUndefined();
  });
});

describe("buildLedgerBookCheckoutSessionParams", () => {
  const baseInput = {
    bookId: "book-1",
    bookTitle: "Test Book",
    priceMinorUnitsAtCheckout: 120000,
    expiresAtSeconds: 1_700_000_000,
    origin: "https://librum.al",
    intentId: "intent-2",
  };

  it("currency is the literal lowercase all", () => {
    const params = buildLedgerBookCheckoutSessionParams(baseInput);
    expect(params.line_items?.[0].price_data?.currency).toBe("all");
  });

  it("unit_amount uses internal minor units directly -- no /100, no FX, no USD conversion", () => {
    const params = buildLedgerBookCheckoutSessionParams(baseInput);
    // stored price_cents = 120000 -> Stripe amount = 120000 (1200.00 ALL),
    // exactly per Section 8's worked example.
    expect(params.line_items?.[0].price_data?.unit_amount).toBe(120000);
  });

  it("never reuses MIN_CHARGE_CENTS as an ALL business rule", () => {
    const params = buildLedgerBookCheckoutSessionParams({
      ...baseInput,
      priceMinorUnitsAtCheckout: 10,
    });
    // A tiny ALL amount (10 minor units = 0.10 ALL) passes through
    // completely unmodified -- this builder applies no USD-cents floor.
    expect(params.line_items?.[0].price_data?.unit_amount).toBe(10);
    expect(params.line_items?.[0].price_data?.unit_amount).not.toBe(MIN_CHARGE_CENTS);
  });

  it("has NO payment_intent_data at all -- no Connect destination, no application fee", () => {
    const params = buildLedgerBookCheckoutSessionParams(baseInput);
    expect(params.payment_intent_data).toBeUndefined();
  });

  it("restricts payment_method_types to card only (STRIPE-CUTOVER-2A.1 Section 3) -- no asynchronous settlement path", () => {
    const params = buildLedgerBookCheckoutSessionParams(baseInput);
    expect(params.payment_method_types).toEqual(["card"]);
  });

  it("metadata carries only intent_id -- no authoritative financial facts", () => {
    const params = buildLedgerBookCheckoutSessionParams(baseInput);
    expect(params.metadata).toEqual({ intent_id: "intent-2" });
  });
});
