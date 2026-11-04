import { describe, expect, it } from "vitest";
import {
  authorShareMinor,
  formatShareMinor,
  hasSendTicks,
  isFreeOnlyRightsBasis,
  resolvePricingSubmission,
  royaltyPreview,
  PRICE_INVALID_MESSAGE,
  ROYALTY_RATES_LINE,
  ROYALTY_TAX_LINE,
} from "./book-pricing";
import { PLATFORM_FEE_PERCENT } from "./pricing";
import { librumShareMinor } from "./royalty";

// BD15 P4: the Pricing tab's rules (PLAN-BD15-r1 §2.5).

describe("resolvePricingSubmission", () => {
  it("Falas is 0 for every author", () => {
    expect(resolvePricingSubmission({ mode: "free", price: "999", rightsBasis: "own_rights" })).toEqual({ ok: true, priceAll: 0 });
  });

  it.each([
    ["99", 99],
    ["249", 249],
    ["1.500", 1500],
    ["100000", 100000],
  ])("a paid price %s is %d", (price, expected) => {
    expect(resolvePricingSubmission({ mode: "paid", price, rightsBasis: "own_rights" })).toEqual({ ok: true, priceAll: expected });
  });

  it.each(["0", "1", "98", "100001", "9.99", "-5", "", "abc"])("refuses the paid price %j", (price) => {
    expect(resolvePricingSubmission({ mode: "paid", price, rightsBasis: "own_rights" })).toEqual({
      ok: false,
      reason: "invalid_price",
    });
  });

  it("refuses a missing or unknown mode", () => {
    expect(resolvePricingSubmission({ mode: null, price: "", rightsBasis: null })).toEqual({ ok: false, reason: "missing_mode" });
    expect(resolvePricingSubmission({ mode: "cheap", price: "", rightsBasis: null })).toEqual({ ok: false, reason: "missing_mode" });
  });

  it("a public-domain book is 0 whatever is sent; a new translation is not forced", () => {
    expect(resolvePricingSubmission({ mode: "paid", price: "500", rightsBasis: "public_domain" })).toEqual({ ok: true, priceAll: 0 });
    expect(resolvePricingSubmission({ mode: null, price: "", rightsBasis: "public_domain" })).toEqual({ ok: true, priceAll: 0 });
    expect(isFreeOnlyRightsBasis("public_domain_original")).toBe(false);
    expect(isFreeOnlyRightsBasis("own_rights")).toBe(false);
  });
});

describe("hasSendTicks", () => {
  const f = (entries: Record<string, string>) => {
    const d = new FormData();
    for (const [k, v] of Object.entries(entries)) d.set(k, v);
    return d;
  };
  it("needs both boxes ticked", () => {
    expect(hasSendTicks(f({ worldwideRights: "on", acceptAuthorTerms: "on" }))).toBe(true);
    expect(hasSendTicks(f({ worldwideRights: "on" }))).toBe(false);
    expect(hasSendTicks(f({ acceptAuthorTerms: "on" }))).toBe(false);
    expect(hasSendTicks(f({ worldwideRights: "yes", acceptAuthorTerms: "on" }))).toBe(false);
  });
});

describe("royaltyPreview (D3 rates, display only)", () => {
  it("free, empty and too low", () => {
    expect(royaltyPreview("free", "")).toEqual({ kind: "free" });
    expect(royaltyPreview(null, "500")).toEqual({ kind: "empty" });
    expect(royaltyPreview("paid", "  ")).toEqual({ kind: "empty" });
    expect(royaltyPreview("paid", "50")).toEqual({ kind: "too_low" });
    expect(royaltyPreview("paid", "0")).toEqual({ kind: "too_low" });
  });

  it("70% from 199 lek, no upsell", () => {
    expect(royaltyPreview("paid", "199")).toEqual({ kind: "paid", priceAll: 199, percent: 70, authorMinor: 13930, upsell: null });
    expect(royaltyPreview("paid", "990")).toMatchObject({ percent: 70, authorMinor: 69300 });
  });

  it("50% below 199 lek, with what 199 would pay", () => {
    expect(royaltyPreview("paid", "99")).toEqual({
      kind: "paid",
      priceAll: 99,
      percent: 50,
      authorMinor: 4950,
      upsell: { priceAll: 199, authorMinor: 13930, percent: 70 },
    });
  });

  it("the author's share plus Librum's is the whole price", () => {
    for (const p of [99, 150, 198, 199, 249, 999, 100000]) {
      expect(authorShareMinor(p) + librumShareMinor(p * 100)).toBe(p * 100);
    }
  });

  it("formats lek and qindarka the Albanian way", () => {
    expect(formatShareMinor(69300)).toBe("693 lekë");
    expect(formatShareMinor(4950)).toBe("49,50 lekë");
    expect(formatShareMinor(13930)).toBe("139,30 lekë");
    expect(formatShareMinor(7000005)).toBe("70.000,05 lekë");
  });

  it("the ledger rate is untouched until the POK build (BD2 1a)", () => {
    expect(PLATFORM_FEE_PERCENT).toBe(20);
  });
});

describe("words", () => {
  it("the agreed tax line, unchanged (Renato 11-04 Q1 b)", () => {
    expect(ROYALTY_TAX_LINE).toBe("Shuma është para tatimit 15% që mbahet në burim.");
    expect(ROYALTY_RATES_LINE).toBe("50% për çmime nën 199 lekë, 70% nga 199 lekë e lart.");
    expect(PRICE_INVALID_MESSAGE).toBe(
      "Shkruani një çmim në lekë të plota, nga 99 deri në 100.000, ose zgjidhni “Falas”.",
    );
  });
});
