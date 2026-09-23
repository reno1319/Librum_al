import { describe, expect, it } from "vitest";
import {
  platformFeeCents,
  applyDiscount,
  MIN_CHARGE_CENTS,
  AUTHOR_ROYALTY_RATE_BPS,
  PLATFORM_FEE_PERCENT,
} from "./pricing";

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
