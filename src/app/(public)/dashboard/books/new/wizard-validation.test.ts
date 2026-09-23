import { describe, expect, it } from "vitest";
import { platformFeeCents } from "@/lib/pricing";
import { calculateAuthorEarnings } from "@/lib/earnings-calculator";
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

// ALL-WIRING-2: the step gate IS parseCatalogPriceAll, so this suite
// asserts the wizard cannot advance an author past a price the server
// will then refuse. "9.99" used to pass here and fail on save.
describe("canAdvanceFromPrice", () => {
  it("accepts zero as a valid free price, in every binding form", () => {
    for (const free of ["0", "0.00", "0,00", "00"]) {
      expect(canAdvanceFromPrice({ price: free })).toBe(true);
    }
  });

  it("accepts a paid whole-lek price, in every binding form", () => {
    for (const paid of ["99", "99.00", "99,00", "099", "100000", " 250 "]) {
      expect(canAdvanceFromPrice({ price: paid })).toBe(true);
    }
  });

  it("rejects a fractional lek price -- the catalog cannot store one", () => {
    for (const bad of ["9.99", "99,50", "0.01", "98,99"]) {
      expect(canAdvanceFromPrice({ price: bad })).toBe(false);
    }
  });

  it("rejects the unsellable 1..98 band and anything above the ceiling", () => {
    for (const bad of ["1", "50", "98", "100001", "999999"]) {
      expect(canAdvanceFromPrice({ price: bad })).toBe(false);
    }
  });

  it("rejects signed, exponent, grouped, blank and non-numeric input", () => {
    for (const bad of ["-1", "+99", "1e3", "1.234,56", "1,234", "abc", "", "   "]) {
      expect(canAdvanceFromPrice({ price: bad })).toBe(false);
    }
  });
});

describe("resolveWizardPriceSummary", () => {
  it("treats 0 ALL as a distinct free-book state with no fee/earnings", () => {
    const result = resolveWizardPriceSummary("0");
    expect(result).toEqual({
      priceValid: true,
      isFreeBook: true,
      priceAll: 0,
      grossMinor: 0,
      feeMinor: 0,
      earningsMinor: 0,
    });
  });

  it("accepts the comma decimal binding form the ALL input now allows", () => {
    expect(resolveWizardPriceSummary("990,00")).toEqual(
      resolveWizardPriceSummary("990"),
    );
  });

  it("never disagrees with calculateAuthorEarnings, which owns the split", () => {
    for (const price of ["99", "499", "999", "1999", "100000"]) {
      const priceAll = Number(price);
      const expected = calculateAuthorEarnings(priceAll, 1);
      const result = resolveWizardPriceSummary(price);
      expect(result.priceAll).toBe(priceAll);
      expect(result.grossMinor).toBe(priceAll * 100);
      expect(result.feeMinor).toBe(expected.platformFeeMinor);
      expect(result.earningsMinor).toBe(expected.authorEarningsMinor);
      // And, transitively, with platformFeeCents itself.
      expect(result.feeMinor).toBe(platformFeeCents(priceAll * 100));
    }
  });

  it("fee + earnings always sum back to the exact gross, never dropping or inventing a minor unit", () => {
    const result = resolveWizardPriceSummary("999");
    expect(result.feeMinor + result.earningsMinor).toBe(result.grossMinor);
  });

  it("reports priceValid: false with a zeroed summary for every rejected form", () => {
    const zeroed = {
      priceValid: false,
      isFreeBook: false,
      priceAll: 0,
      grossMinor: 0,
      feeMinor: 0,
      earningsMinor: 0,
    };
    for (const bad of ["-5", "abc", "9.99", "50", "100001", ""]) {
      expect(resolveWizardPriceSummary(bad)).toEqual(zeroed);
    }
  });

  // The summary must never present a rejected price as a FREE book --
  // that is how an author would be shown "Free book" for a typo and
  // then be refused at save time, or worse, save a free book by
  // accident.
  it("a rejected price is never reported as free", () => {
    expect(resolveWizardPriceSummary("abc").isFreeBook).toBe(false);
    expect(resolveWizardPriceSummary("9.99").isFreeBook).toBe(false);
  });
});
