import { describe, expect, it } from "vitest";
import {
  formatPrice,
  platformFeeCents,
  MIN_CHARGE_CENTS,
  AUTHOR_ROYALTY_RATE_BPS,
  PLATFORM_FEE_PERCENT,
} from "./pricing";

// ALL-CATALOG-2: formatPrice() is now the ONE reader-facing price
// formatter and it renders ALL, not USD. formatAllPrice() -- which used
// to exist alongside it so a single page could show lek while every
// other surface showed dollars -- is gone, and its cases are folded in
// here. Every expectation below is in Albanian convention: a dot groups
// thousands, a comma separates the decimals, and the suffix is " ALL".
describe("formatPrice", () => {
  it("renders exactly 0 minor units as Free, never 0,00 ALL", () => {
    expect(formatPrice(0)).toBe("Free");
  });

  it("renders a whole-lek price with two decimal places", () => {
    expect(formatPrice(500)).toBe("5,00 ALL");
  });

  it("renders a price with a fractional part", () => {
    expect(formatPrice(1299)).toBe("12,99 ALL");
  });

  it("renders a sub-lek price", () => {
    expect(formatPrice(50)).toBe("0,50 ALL");
  });

  it("groups thousands with a dot", () => {
    expect(formatPrice(120000)).toBe("1.200,00 ALL");
  });

  // Regression: the book detail page's own ad-hoc
  // `Intl.NumberFormat("en", {style:"currency",currency:"ALL"})` rounded
  // this exact fixture price to "ALL 8" under this runtime's default CLDR
  // fraction-digit data for ALL. This is the formatter every page now
  // calls instead -- confirms the fixture's exact price renders precisely.
  it("renders 799 minor units (this staging fixture's price) as 7,99 ALL, not rounded to 8", () => {
    expect(formatPrice(799)).toBe("7,99 ALL");
  });

  // The stored number is lek minor units and is divided by exactly 100 to
  // reach lek. No FX, no USD conversion, at any point -- see
  // POK_STAGING.md's "ALL is the ledger's frozen currency".
  it("never renders a dollar sign for any amount", () => {
    for (const minor of [1, 50, 999, 9900, 120000, 10000000]) {
      expect(formatPrice(minor)).not.toContain("$");
      expect(formatPrice(minor)).toContain("ALL");
    }
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

// ALL-CATALOG-2: applyDiscount() is gone -- it was unreachable from
// production and carried a USD floor. MIN_CHARGE_CENTS survives only as
// the subject of the guard tests in checkout-logic.test.ts that assert
// it never becomes an ALL business rule; this test pins what it is so
// that a future reader cannot mistake it for a lek amount.
describe("MIN_CHARGE_CENTS", () => {
  it("is the legacy USD 50-cent Stripe minimum, not a lek floor", () => {
    expect(MIN_CHARGE_CENTS).toBe(50);
  });
});
