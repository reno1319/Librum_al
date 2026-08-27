import { describe, expect, it } from "vitest";
import { calculateAuthorEarnings } from "./earnings-calculator";
import { platformFeeCents, PLATFORM_FEE_PERCENT } from "./pricing";

describe("calculateAuthorEarnings", () => {
  it("computes a standard paid price for one sale", () => {
    const result = calculateAuthorEarnings(999, 1); // $9.99
    expect(result).toEqual({
      grossCents: 999,
      platformFeeCents: 200, // round(999 * 0.20) = round(199.8) = 200
      authorEarningsCents: 799,
    });
  });

  it("treats a free (zero-price) book as no author earnings, not a negative/meaningless result", () => {
    const result = calculateAuthorEarnings(0, 100);
    expect(result).toEqual({ grossCents: 0, platformFeeCents: 0, authorEarningsCents: 0 });
  });

  it("handles exactly one sale", () => {
    const result = calculateAuthorEarnings(500, 1);
    expect(result).toEqual({ grossCents: 500, platformFeeCents: 100, authorEarningsCents: 400 });
  });

  it("handles multiple sales by scaling the per-sale figures", () => {
    const result = calculateAuthorEarnings(500, 10);
    expect(result).toEqual({ grossCents: 5000, platformFeeCents: 1000, authorEarningsCents: 4000 });
  });

  it("rounds $0.99 the same way platformFeeCents() itself rounds it", () => {
    const result = calculateAuthorEarnings(99, 1);
    expect(result.platformFeeCents).toBe(platformFeeCents(99)); // round(19.8) = 20
    expect(result.authorEarningsCents).toBe(99 - platformFeeCents(99));
  });

  it("rounds $4.99 the same way platformFeeCents() itself rounds it", () => {
    const result = calculateAuthorEarnings(499, 1);
    expect(result.platformFeeCents).toBe(platformFeeCents(499)); // round(99.8) = 100
    expect(result.authorEarningsCents).toBe(499 - platformFeeCents(499));
  });

  it("handles a large sales count without drift, matching per-sale rounding times count", () => {
    const result = calculateAuthorEarnings(499, 10_000);
    const perSaleFee = platformFeeCents(499);
    expect(result.grossCents).toBe(499 * 10_000);
    expect(result.platformFeeCents).toBe(perSaleFee * 10_000);
    expect(result.authorEarningsCents).toBe((499 - perSaleFee) * 10_000);
  });

  it("never rounds the fee on the aggregated gross instead of per-sale (the two can legitimately differ)", () => {
    // 99 cents at 20%: per-sale fee is round(19.8) = 20, times 3 sales = 60.
    // Aggregating first would be round(297 * 0.20) = round(59.4) = 59 -- a
    // different number. This calculator must match the per-sale rule Sales
    // dashboard/Stripe checkout actually use, not the aggregate one.
    const result = calculateAuthorEarnings(99, 3);
    expect(result.platformFeeCents).toBe(60);
    expect(result.platformFeeCents).not.toBe(Math.round(297 * (PLATFORM_FEE_PERCENT / 100)));
  });

  it("clamps a negative or NaN price to zero rather than producing a negative/NaN result", () => {
    expect(calculateAuthorEarnings(-500, 5)).toEqual({
      grossCents: 0,
      platformFeeCents: 0,
      authorEarningsCents: 0,
    });
    expect(calculateAuthorEarnings(NaN, 5)).toEqual({
      grossCents: 0,
      platformFeeCents: 0,
      authorEarningsCents: 0,
    });
  });

  it("clamps a negative, zero, NaN, or fractional sales count safely", () => {
    expect(calculateAuthorEarnings(999, -3)).toEqual({
      grossCents: 0,
      platformFeeCents: 0,
      authorEarningsCents: 0,
    });
    expect(calculateAuthorEarnings(999, NaN)).toEqual({
      grossCents: 0,
      platformFeeCents: 0,
      authorEarningsCents: 0,
    });
    expect(calculateAuthorEarnings(999, 0)).toEqual({
      grossCents: 0,
      platformFeeCents: 0,
      authorEarningsCents: 0,
    });
    // Fractional sales counts floor rather than fabricating a partial sale.
    expect(calculateAuthorEarnings(1000, 2.9)).toEqual({
      grossCents: 2000,
      platformFeeCents: 400,
      authorEarningsCents: 1600,
    });
  });

  it("automatically reflects a change to the platform-fee constant (never a hardcoded 20/80)", () => {
    // Not literally mutating PLATFORM_FEE_PERCENT (it's a real exported
    // const elsewhere in the app) -- instead proves the calculator's fee
    // is DERIVED from platformFeeCents(), by cross-checking against it for
    // several prices rather than against any hardcoded percentage here.
    for (const priceCents of [199, 499, 999, 2999]) {
      const result = calculateAuthorEarnings(priceCents, 1);
      expect(result.platformFeeCents).toBe(platformFeeCents(priceCents));
      expect(result.authorEarningsCents).toBe(priceCents - platformFeeCents(priceCents));
    }
  });
});
