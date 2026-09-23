import { describe, expect, it } from "vitest";
import { calculateAuthorEarnings } from "./earnings-calculator";
import { platformFeeCents, PLATFORM_FEE_PERCENT } from "./pricing";

// ALL-WIRING-2: every figure here is ALL MINOR UNITS and every price
// input is a WHOLE-ALL catalog integer. The old suite's numbers were USD
// cents (999 meaning $9.99); 999 now means nine hundred and ninety-nine
// LEK, which is 99,900 minor units. The rounding rules and the
// derived-from-platformFeeCents contract are unchanged.
describe("calculateAuthorEarnings", () => {
  it("computes a standard paid price for one sale", () => {
    const result = calculateAuthorEarnings(999, 1); // 999 ALL
    expect(result).toEqual({
      grossMinor: 99_900,
      platformFeeMinor: 19_980, // round(99900 * 0.20)
      authorEarningsMinor: 79_920,
    });
  });

  it("treats a free (zero-price) book as no author earnings, not a negative/meaningless result", () => {
    const result = calculateAuthorEarnings(0, 100);
    expect(result).toEqual({ grossMinor: 0, platformFeeMinor: 0, authorEarningsMinor: 0 });
  });

  it("handles exactly one sale", () => {
    const result = calculateAuthorEarnings(500, 1);
    expect(result).toEqual({
      grossMinor: 50_000,
      platformFeeMinor: 10_000,
      authorEarningsMinor: 40_000,
    });
  });

  it("handles multiple sales by scaling the per-sale figures", () => {
    const result = calculateAuthorEarnings(500, 10);
    expect(result).toEqual({
      grossMinor: 500_000,
      platformFeeMinor: 100_000,
      authorEarningsMinor: 400_000,
    });
  });

  // ALL-WIRING-2: at 8000 bps and a whole-lek catalog, the 20% share of
  // `priceAll * 100` is ALWAYS a whole number of minor units -- there is
  // no tie to break and no rounding to get wrong. That is the property
  // the comment beside PLATFORM_FEE_PERCENT records, asserted here over
  // the whole paid domain rather than taken on trust.
  it("never needs to round at the current fee rate: the share is exact for every paid price", () => {
    for (let priceAll = 99; priceAll <= 100_000; priceAll += 1) {
      const grossMinor = priceAll * 100;
      const exact = (grossMinor * PLATFORM_FEE_PERCENT) / 100;
      expect(Number.isInteger(exact)).toBe(true);
      expect(calculateAuthorEarnings(priceAll, 1).platformFeeMinor).toBe(exact);
    }
  });

  it("the two shares always sum to the gross exactly", () => {
    for (const priceAll of [99, 100, 199, 333, 999, 12_345, 100_000]) {
      for (const sales of [1, 3, 10, 10_000]) {
        const r = calculateAuthorEarnings(priceAll, sales);
        expect(r.platformFeeMinor + r.authorEarningsMinor).toBe(r.grossMinor);
      }
    }
  });

  it("handles a large sales count without drift, matching per-sale rounding times count", () => {
    const result = calculateAuthorEarnings(499, 10_000);
    const perSaleFee = platformFeeCents(499 * 100);
    expect(result.grossMinor).toBe(499 * 100 * 10_000);
    expect(result.platformFeeMinor).toBe(perSaleFee * 10_000);
    expect(result.authorEarningsMinor).toBe((499 * 100 - perSaleFee) * 10_000);
  });

  // ALL-WIRING-2: the price domain is Librum's own. A value the catalog
  // could never hold must not produce a plausible-looking estimate --
  // 50 ALL and 100001 ALL are not prices an author can save, and 9.99
  // is not a price at all.
  it("treats any value outside the catalog domain as zero", () => {
    const zero = { grossMinor: 0, platformFeeMinor: 0, authorEarningsMinor: 0 };
    for (const invalid of [1, 50, 98, 100_001, 9.99, -500, NaN, Infinity]) {
      expect(calculateAuthorEarnings(invalid, 5)).toEqual(zero);
    }
  });

  it("clamps a negative, zero, NaN, or fractional sales count safely", () => {
    const zero = { grossMinor: 0, platformFeeMinor: 0, authorEarningsMinor: 0 };
    expect(calculateAuthorEarnings(999, -3)).toEqual(zero);
    expect(calculateAuthorEarnings(999, NaN)).toEqual(zero);
    expect(calculateAuthorEarnings(999, 0)).toEqual(zero);
    // Fractional sales counts floor rather than fabricating a partial sale.
    expect(calculateAuthorEarnings(1000, 2.9)).toEqual({
      grossMinor: 200_000,
      platformFeeMinor: 40_000,
      authorEarningsMinor: 160_000,
    });
  });

  it("automatically reflects a change to the platform-fee constant (never a hardcoded 20/80)", () => {
    // Not literally mutating PLATFORM_FEE_PERCENT (it's a real exported
    // const elsewhere in the app) -- instead proves the calculator's fee
    // is DERIVED from platformFeeCents(), by cross-checking against it for
    // several prices rather than against any hardcoded percentage here.
    for (const priceAll of [199, 499, 999, 2999]) {
      const grossMinor = priceAll * 100;
      const result = calculateAuthorEarnings(priceAll, 1);
      expect(result.platformFeeMinor).toBe(platformFeeCents(grossMinor));
      expect(result.authorEarningsMinor).toBe(grossMinor - platformFeeCents(grossMinor));
    }
  });

  // ALL-WIRING-2: the conversion boundary happens exactly once. A
  // catalog price of 99 is 9900 minor units, never 99 and never 990000.
  it("converts whole lek to minor units exactly once", () => {
    expect(calculateAuthorEarnings(99, 1).grossMinor).toBe(9900);
    expect(calculateAuthorEarnings(100_000, 1).grossMinor).toBe(10_000_000);
  });
});
