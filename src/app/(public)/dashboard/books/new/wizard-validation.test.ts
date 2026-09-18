import { describe, expect, it } from "vitest";
import { platformFeeCents } from "@/lib/pricing";
import {
  canAdvanceFromBookDetails,
  canAdvanceFromFiles,
  canAdvanceFromPrice,
  resolveWizardPriceSummary,
} from "./wizard-validation";

describe("canAdvanceFromBookDetails", () => {
  it("requires a non-blank title, language, and genre", () => {
    expect(
      canAdvanceFromBookDetails({ title: "My Book", language: "sq", genre: "Fiction" }),
    ).toBe(true);
  });

  it("rejects a blank title", () => {
    expect(canAdvanceFromBookDetails({ title: "   ", language: "sq", genre: "Fiction" })).toBe(
      false,
    );
  });

  it("rejects a missing language", () => {
    expect(canAdvanceFromBookDetails({ title: "My Book", language: "", genre: "Fiction" })).toBe(
      false,
    );
  });

  it("rejects a missing genre", () => {
    expect(canAdvanceFromBookDetails({ title: "My Book", language: "sq", genre: "" })).toBe(
      false,
    );
  });
});

describe("canAdvanceFromFiles", () => {
  it("requires both cover and manuscript to be ready", () => {
    expect(canAdvanceFromFiles({ coverReady: true, manuscriptReady: true })).toBe(true);
  });

  it("rejects a missing cover", () => {
    expect(canAdvanceFromFiles({ coverReady: false, manuscriptReady: true })).toBe(false);
  });

  it("rejects a missing manuscript", () => {
    expect(canAdvanceFromFiles({ coverReady: true, manuscriptReady: false })).toBe(false);
  });

  it("rejects when neither is ready", () => {
    expect(canAdvanceFromFiles({ coverReady: false, manuscriptReady: false })).toBe(false);
  });
});

// ALL-CATALOG-2: the gate now parses through parseCatalogPriceAll(),
// whose domain is whole lek -- exactly 0, or 99 through 100,000. It was
// `Number(price) >= 0`, which accepted "9.99" and every other value the
// author could never actually save. The cases below are the domain's
// real edges, not dollar amounts.
describe("canAdvanceFromPrice", () => {
  it("accepts zero as a valid free price", () => {
    expect(canAdvanceFromPrice({ price: "0" })).toBe(true);
  });

  it("accepts the minimum paid price", () => {
    expect(canAdvanceFromPrice({ price: "99" })).toBe(true);
  });

  it("accepts an ordinary book price in lek", () => {
    expect(canAdvanceFromPrice({ price: "1200" })).toBe(true);
  });

  it("accepts the maximum catalog price", () => {
    expect(canAdvanceFromPrice({ price: "100000" })).toBe(true);
  });

  it("rejects a price between free and the paid minimum", () => {
    expect(canAdvanceFromPrice({ price: "98" })).toBe(false);
  });

  it("rejects a price above the catalog maximum", () => {
    expect(canAdvanceFromPrice({ price: "100001" })).toBe(false);
  });

  // Regression for the currency defect this fix exists to close: "9.99"
  // was the shape of a dollar price, it passed this gate, and it became
  // a 9.99 ALL charge -- about ten cents. Lek is not priced in
  // fractions here; the catalog domain is whole lek only.
  it("rejects a fractional price, the shape a dollar amount used to take", () => {
    expect(canAdvanceFromPrice({ price: "9.99" })).toBe(false);
  });

  it("rejects a negative price", () => {
    expect(canAdvanceFromPrice({ price: "-1" })).toBe(false);
  });

  it("rejects a non-numeric price", () => {
    expect(canAdvanceFromPrice({ price: "abc" })).toBe(false);
  });

  it("rejects a blank price", () => {
    expect(canAdvanceFromPrice({ price: "" })).toBe(false);
  });
});

describe("resolveWizardPriceSummary", () => {
  it("treats 0 as a distinct free-book state with no fee/earnings", () => {
    const result = resolveWizardPriceSummary("0");
    expect(result).toEqual({
      priceValid: true,
      isFreeBook: true,
      priceCents: 0,
      feeCents: 0,
      earningsCents: 0,
    });
  });

  it("never disagrees with platformFeeCents() -- the exact function real checkout/Sales already use", () => {
    for (const lek of ["99", "500", "1200", "9900", "100000"]) {
      // ALL-CATALOG-2: minor units are hundredths of a lek, so the
      // conversion is a plain * 100 with no rounding -- the domain is
      // whole lek and nothing fractional ever reaches here.
      const priceMinor = Number(lek) * 100;
      const result = resolveWizardPriceSummary(lek);
      expect(result.priceCents).toBe(priceMinor);
      expect(result.feeCents).toBe(platformFeeCents(priceMinor));
      expect(result.earningsCents).toBe(priceMinor - platformFeeCents(priceMinor));
    }
  });

  it("fee + earnings always sum back to the exact price, never dropping or inventing a minor unit", () => {
    const result = resolveWizardPriceSummary("999");
    expect(result.feeCents + result.earningsCents).toBe(result.priceCents);
  });

  it("reports priceValid: false for a negative or non-numeric price, with a zeroed summary", () => {
    expect(resolveWizardPriceSummary("-5")).toEqual({
      priceValid: false,
      isFreeBook: false,
      priceCents: 0,
      feeCents: 0,
      earningsCents: 0,
    });
    expect(resolveWizardPriceSummary("abc")).toEqual({
      priceValid: false,
      isFreeBook: false,
      priceCents: 0,
      feeCents: 0,
      earningsCents: 0,
    });
  });
});
