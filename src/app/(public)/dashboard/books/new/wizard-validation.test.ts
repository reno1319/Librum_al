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

describe("canAdvanceFromPrice", () => {
  it("accepts zero as a valid free price", () => {
    expect(canAdvanceFromPrice({ price: "0" })).toBe(true);
  });

  it("accepts a positive price", () => {
    expect(canAdvanceFromPrice({ price: "9.99" })).toBe(true);
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
  it("treats $0 as a distinct free-book state with no fee/earnings", () => {
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
    for (const dollars of ["9.99", "4.99", "19.99", "1", "0.50"]) {
      const priceCents = Math.round(Number(dollars) * 100);
      const result = resolveWizardPriceSummary(dollars);
      expect(result.priceCents).toBe(priceCents);
      expect(result.feeCents).toBe(platformFeeCents(priceCents));
      expect(result.earningsCents).toBe(priceCents - platformFeeCents(priceCents));
    }
  });

  it("fee + earnings always sum back to the exact price, never dropping or inventing a cent", () => {
    const result = resolveWizardPriceSummary("9.99");
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
