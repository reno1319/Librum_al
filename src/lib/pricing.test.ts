import { describe, expect, it } from "vitest";
import { formatPrice, platformFeeCents, applyDiscount, MIN_CHARGE_CENTS } from "./pricing";

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
