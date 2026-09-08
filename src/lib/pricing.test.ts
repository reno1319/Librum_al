import { describe, expect, it } from "vitest";
import {
  formatPrice,
  formatAllPrice,
  platformFeeCents,
  applyDiscount,
  MIN_CHARGE_CENTS,
  AUTHOR_ROYALTY_RATE_BPS,
  PLATFORM_FEE_PERCENT,
} from "./pricing";

describe("formatPrice", () => {
  it("renders exactly 0 cents as Free, never $0.00", () => {
    expect(formatPrice(0)).toBe("Free");
  });

  it("renders a whole-dollar price with two decimal places", () => {
    expect(formatPrice(500)).toBe("$5.00");
  });

  it("renders a price with cents", () => {
    expect(formatPrice(1299)).toBe("$12.99");
  });

  it("renders a sub-dollar price", () => {
    expect(formatPrice(50)).toBe("$0.50");
  });
});

describe("platformFeeCents", () => {
  it("computes the platform's cut at PLATFORM_FEE_PERCENT", () => {
    expect(platformFeeCents(1000)).toBe(200);
  });
});

describe("AUTHOR_ROYALTY_RATE_BPS", () => {
  it("is derived from PLATFORM_FEE_PERCENT, not a separately hardcoded value", () => {
    expect(AUTHOR_ROYALTY_RATE_BPS).toBe((100 - PLATFORM_FEE_PERCENT) * 100);
  });

  it("equals 8000 bps (80%) at the current 20% platform fee", () => {
    expect(AUTHOR_ROYALTY_RATE_BPS).toBe(8000);
  });
});

describe("formatAllPrice", () => {
  it("renders exactly 0 minor units as Free, never 0.00 ALL", () => {
    expect(formatAllPrice(0)).toBe("Free");
  });

  it("renders a whole-unit price with two decimal places and an ALL suffix", () => {
    expect(formatAllPrice(1000)).toBe("10.00 ALL");
  });

  it("renders a large price with two decimal digits", () => {
    expect(formatAllPrice(120000)).toBe("1200.00 ALL");
  });

  it("renders a sub-unit price", () => {
    expect(formatAllPrice(50)).toBe("0.50 ALL");
  });

  it("never divides by anything other than 100 -- no FX, no USD conversion", () => {
    // 1200.00 ALL stored as 120000 minor units, per the locked product
    // decision -- not converted from/to any other currency's amount.
    expect(formatAllPrice(120000)).not.toBe(formatPrice(120000));
    expect(formatAllPrice(120000)).toBe("1200.00 ALL");
  });
});

describe("applyDiscount", () => {
  it("applies a percent-off discount", () => {
    expect(applyDiscount(1000, { percent_off: 25, amount_off_cents: null })).toBe(750);
  });

  it("applies a flat amount-off discount", () => {
    expect(applyDiscount(1000, { percent_off: null, amount_off_cents: 300 })).toBe(700);
  });

  it("floors the discounted price at MIN_CHARGE_CENTS", () => {
    expect(applyDiscount(100, { percent_off: 90, amount_off_cents: null })).toBe(MIN_CHARGE_CENTS);
  });
});
