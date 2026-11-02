import { describe, expect, it } from "vitest";
import {
  librumShareMinor,
  REDUCED_ROYALTY_PERCENT,
  ROYALTY_DISCOUNT_NOTE,
  ROYALTY_HEADLINE_CAPTION,
  ROYALTY_PAID_PRICE_SENTENCE,
  ROYALTY_RULE_SENTENCE,
  ROYALTY_TIERS_LINE,
  royaltyPercentForPaidMinor,
  STANDARD_ROYALTY_FROM_ALL,
  STANDARD_ROYALTY_PERCENT,
} from "./royalty";
import { AUTHOR_ROYALTY_RATE_BPS, PLATFORM_FEE_PERCENT } from "./pricing";

// BD2: the decided tiers (D2, D3), on the amount actually paid.
describe("royalty tiers", () => {
  it("are 70% from 199 lek and 50% below", () => {
    expect(STANDARD_ROYALTY_PERCENT).toBe(70);
    expect(REDUCED_ROYALTY_PERCENT).toBe(50);
    expect(STANDARD_ROYALTY_FROM_ALL).toBe(199);
  });

  it("switch at exactly 199 lek (19,900 minor units)", () => {
    expect(royaltyPercentForPaidMinor(19_900)).toBe(70);
    expect(royaltyPercentForPaidMinor(19_899)).toBe(50);
    expect(royaltyPercentForPaidMinor(9_900)).toBe(50);
    expect(royaltyPercentForPaidMinor(10_000_000)).toBe(70);
  });

  it("decide a discounted price by what is paid (199 lek less 10% = 179,10 lek pays 50%)", () => {
    expect(royaltyPercentForPaidMinor(17_910)).toBe(50);
    expect(librumShareMinor(17_910)).toBe(8_955);
  });

  it("round Librum's share half away from zero and leave the author the remainder", () => {
    // 70% tier, 30% of 19,901 = 5,970.3 -> 5,970; of 19,905 = 5,971.5 -> 5,972
    expect(librumShareMinor(19_901)).toBe(5_970);
    expect(librumShareMinor(19_905)).toBe(5_972);
    // 50% tier, 50% of 9,901 = 4,950.5 -> 4,951
    expect(librumShareMinor(9_901)).toBe(4_951);
  });

  // 1a: display only. The ledger is NOT switched by BD2; this test fails
  // on purpose when the POK build (N6) changes it, so that build must
  // also point the ledger at these tiers and update this test.
  it("leave the real checkout rate alone until the POK build (N6)", () => {
    expect(PLATFORM_FEE_PERCENT).toBe(20);
    expect(AUTHOR_ROYALTY_RATE_BPS).toBe(8000);
  });
});

describe("royalty sentences", () => {
  it("are built from the constants", () => {
    expect(ROYALTY_HEADLINE_CAPTION).toBe("për libra nga 199 lekë; 50% nën 199 lekë");
    expect(ROYALTY_TIERS_LINE).toBe(
      "Honorari i autorit: 70% e çmimit që paguan lexuesi, nga 199 lekë e lart; 50% nën 199 lekë.",
    );
    expect(ROYALTY_RULE_SENTENCE).toBe(
      "Librum e shet librin tuaj dhe për çdo shitje ju paguan një honorar: 70% të çmimit që paguan lexuesi kur çmimi është 199 lekë ose më shumë, dhe 50% kur është nën 199 lekë.",
    );
    expect(ROYALTY_PAID_PRICE_SENTENCE).toBe(
      "Vlen çmimi që paguhet realisht, pas çdo kodi zbritjeje; për një paketë vlen çmimi i paketës.",
    );
    expect(ROYALTY_DISCOUNT_NOTE).toBe(
      "Honorari llogaritet nga çmimi pas zbritjes: nëse një kod e çon çmimin nën 199 lekë, honorari juaj për atë shitje është 50% dhe jo 70%.",
    );
  });

  it("never say platform fee or 80%", () => {
    for (const s of [ROYALTY_HEADLINE_CAPTION, ROYALTY_TIERS_LINE, ROYALTY_RULE_SENTENCE, ROYALTY_PAID_PRICE_SENTENCE, ROYALTY_DISCOUNT_NOTE]) {
      expect(s).not.toMatch(/tarif|80%|20%/);
    }
  });
});
