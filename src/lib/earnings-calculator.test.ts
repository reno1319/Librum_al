import { describe, expect, it } from "vitest";
import { calculateAuthorEarnings } from "./earnings-calculator";
import { librumShareMinor, REDUCED_ROYALTY_PERCENT, STANDARD_ROYALTY_PERCENT } from "./royalty";

// ALL-WIRING-2: every figure here is ALL MINOR UNITS and every price
// input is a WHOLE-ALL catalog integer (999 means 999 lek = 99,900 minor
// units). BD2 (Renato 11-01, 1a): the estimate follows the decided
// royalty tiers in ./royalty (70% from 199 lek, 50% below), not the
// ledger's PLATFORM_FEE_PERCENT, which stays 80/20 until the POK build.
const zero = { grossMinor: 0, librumShareMinor: 0, authorEarningsMinor: 0, royaltyPercent: 0 };

describe("calculateAuthorEarnings", () => {
  it("pays 70% from 199 lek", () => {
    expect(calculateAuthorEarnings(999, 1)).toEqual({
      grossMinor: 99_900,
      librumShareMinor: 29_970,
      authorEarningsMinor: 69_930,
      royaltyPercent: 70,
    });
  });

  it("pays 70% at exactly 199 lek, and 50% at 198 lek", () => {
    expect(calculateAuthorEarnings(199, 1)).toEqual({
      grossMinor: 19_900,
      librumShareMinor: 5_970,
      authorEarningsMinor: 13_930,
      royaltyPercent: 70,
    });
    expect(calculateAuthorEarnings(198, 1)).toEqual({
      grossMinor: 19_800,
      librumShareMinor: 9_900,
      authorEarningsMinor: 9_900,
      royaltyPercent: 50,
    });
  });

  it("pays 50% at the 99 lek minimum", () => {
    expect(calculateAuthorEarnings(99, 1)).toEqual({
      grossMinor: 9_900,
      librumShareMinor: 4_950,
      authorEarningsMinor: 4_950,
      royaltyPercent: 50,
    });
  });

  it("treats a free (zero-price) book as no author earnings", () => {
    expect(calculateAuthorEarnings(0, 100)).toEqual(zero);
  });

  it("handles multiple sales by scaling the per-sale figures", () => {
    expect(calculateAuthorEarnings(500, 10)).toEqual({
      grossMinor: 500_000,
      librumShareMinor: 150_000,
      authorEarningsMinor: 350_000,
      royaltyPercent: 70,
    });
  });

  // Whole-lek prices at 70% or 50% never need rounding.
  it("is exact for every paid catalog price, with the right tier", () => {
    for (let priceAll = 99; priceAll <= 100_000; priceAll += 1) {
      const grossMinor = priceAll * 100;
      const percent = priceAll >= 199 ? STANDARD_ROYALTY_PERCENT : REDUCED_ROYALTY_PERCENT;
      const exactLibrum = (grossMinor * (100 - percent)) / 100;
      expect(Number.isInteger(exactLibrum)).toBe(true);
      const r = calculateAuthorEarnings(priceAll, 1);
      expect(r.librumShareMinor).toBe(exactLibrum);
      expect(r.royaltyPercent).toBe(percent);
    }
  });

  it("the two shares always sum to the gross exactly", () => {
    for (const priceAll of [99, 100, 198, 199, 333, 999, 12_345, 100_000]) {
      for (const sales of [1, 3, 10, 10_000]) {
        const r = calculateAuthorEarnings(priceAll, sales);
        expect(r.librumShareMinor + r.authorEarningsMinor).toBe(r.grossMinor);
      }
    }
  });

  it("rounds per sale, then multiplies", () => {
    const result = calculateAuthorEarnings(499, 10_000);
    const perSale = librumShareMinor(499 * 100);
    expect(result.librumShareMinor).toBe(perSale * 10_000);
    expect(result.authorEarningsMinor).toBe((499 * 100 - perSale) * 10_000);
  });

  it("treats any value outside the catalog domain as zero", () => {
    for (const invalid of [1, 50, 98, 100_001, 9.99, -500, NaN, Infinity]) {
      expect(calculateAuthorEarnings(invalid, 5)).toEqual(zero);
    }
  });

  it("clamps a negative, zero, NaN, or fractional sales count safely", () => {
    expect(calculateAuthorEarnings(999, -3)).toEqual(zero);
    expect(calculateAuthorEarnings(999, NaN)).toEqual(zero);
    expect(calculateAuthorEarnings(999, 0)).toEqual(zero);
    expect(calculateAuthorEarnings(1000, 2.9)).toEqual({
      grossMinor: 200_000,
      librumShareMinor: 60_000,
      authorEarningsMinor: 140_000,
      royaltyPercent: 70,
    });
  });

  it("converts whole lek to minor units exactly once", () => {
    expect(calculateAuthorEarnings(99, 1).grossMinor).toBe(9900);
    expect(calculateAuthorEarnings(100_000, 1).grossMinor).toBe(10_000_000);
  });
});
