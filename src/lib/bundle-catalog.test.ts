import { describe, expect, it } from "vitest";
import {
  BUNDLE_CHECKOUT_COMING_SOON_NOTICE,
  BUNDLE_UNAVAILABLE_NOTICE,
  bundleCheckoutNotice,
  formatBundleSavingsAll,
  resolveBundleSavingsAll,
} from "./bundle-catalog";

// ALL-WIRING-5: the bundle page's "bought separately" rule and its
// checkout notice, as pure functions. Members carry a legacy
// `price_cents` in several cases below purely as bait: the functions
// must never read it.

const m = (price_all: unknown, price_cents = 99_999) => ({ price_all, price_cents });

describe("resolveBundleSavingsAll", () => {
  it("sums explicit member prices and subtracts the bundle's, in whole lek", () => {
    expect(resolveBundleSavingsAll(199, [m(150), m(120)])).toEqual({
      show: true,
      originalTotalAll: 270,
      savingsAll: 71,
    });
  });

  it("an explicitly free member contributes zero because it IS free", () => {
    expect(resolveBundleSavingsAll(199, [m(0), m(300)])).toEqual({
      show: true,
      originalTotalAll: 300,
      savingsAll: 101,
    });
  });

  it("a free bundle of priced books saves their whole total", () => {
    expect(resolveBundleSavingsAll(0, [m(150), m(120)])).toEqual({
      show: true,
      originalTotalAll: 270,
      savingsAll: 270,
    });
  });

  it.each([
    ["null", null],
    ["undefined (column not selected)", undefined],
    ["1 (below the floor)", 1],
    ["100001 (above the ceiling)", 100_001],
    ["a fraction", 150.5],
    ["a string", "150"],
    ["negative zero", -0],
  ])("a member priced %s withholds the comparison -- never counted as zero", (_label, value) => {
    expect(resolveBundleSavingsAll(99, [m(150), m(value)])).toEqual({ show: false });
  });

  it("a member missing the price_all key entirely withholds the comparison", () => {
    expect(resolveBundleSavingsAll(99, [m(150), { price_cents: 100 } as { price_all?: unknown }])).toEqual({
      show: false,
    });
  });

  it("an unresolvable member (null join) withholds the comparison", () => {
    expect(resolveBundleSavingsAll(99, [m(150), m(120), null])).toEqual({ show: false });
  });

  it("no members at all: nothing to compare", () => {
    expect(resolveBundleSavingsAll(99, [])).toEqual({ show: false });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["98", 98],
    ["a string", "199"],
  ])("a bundle priced %s shows no comparison", (_label, value) => {
    expect(resolveBundleSavingsAll(value, [m(150), m(120)])).toEqual({ show: false });
  });

  it("a zero saving is not a saving", () => {
    expect(resolveBundleSavingsAll(270, [m(150), m(120)])).toEqual({ show: false });
  });

  it("a negative saving is not a saving", () => {
    expect(resolveBundleSavingsAll(300, [m(150), m(120)])).toEqual({ show: false });
  });

  it("never reads price_cents: identical answers whatever the legacy values are", () => {
    const a = resolveBundleSavingsAll(199, [m(150, 0), m(120, 0)]);
    const b = resolveBundleSavingsAll(199, [m(150, 1_000_000), m(120, 1)]);
    expect(a).toEqual(b);
  });

  it("stays exact at the largest totals the domain allows", () => {
    const members = Array.from({ length: 1000 }, () => m(100_000));
    const result = resolveBundleSavingsAll(100_000, members);
    expect(result).toEqual({ show: true, originalTotalAll: 100_000_000, savingsAll: 99_900_000 });
  });
});

describe("formatBundleSavingsAll", () => {
  it("formats both figures with the canonical whole-ALL shape", () => {
    expect(formatBundleSavingsAll({ show: true, originalTotalAll: 270, savingsAll: 71 })).toEqual({
      originalTotal: "270,00 ALL",
      savings: "71,00 ALL",
    });
    expect(formatBundleSavingsAll({ show: true, originalTotalAll: 250_000, savingsAll: 150_001 })).toEqual({
      originalTotal: "250.000,00 ALL",
      savings: "150.001,00 ALL",
    });
  });

  it("returns nothing to render when the comparison is withheld", () => {
    expect(formatBundleSavingsAll({ show: false })).toBeNull();
  });
});

describe("bundleCheckoutNotice", () => {
  it("an unpriced bundle is not available", () => {
    expect(bundleCheckoutNotice(null)).toBe(BUNDLE_UNAVAILABLE_NOTICE);
    expect(bundleCheckoutNotice(undefined)).toBe(BUNDLE_UNAVAILABLE_NOTICE);
    expect(bundleCheckoutNotice(98)).toBe(BUNDLE_UNAVAILABLE_NOTICE);
  });

  it("free and paid bundles get the same neutral coming-soon notice", () => {
    expect(bundleCheckoutNotice(0)).toBe(BUNDLE_CHECKOUT_COMING_SOON_NOTICE);
    expect(bundleCheckoutNotice(199)).toBe(BUNDLE_CHECKOUT_COMING_SOON_NOTICE);
  });

  it("no notice says 'paid' or implies a purchase can be made", () => {
    for (const notice of [BUNDLE_UNAVAILABLE_NOTICE, BUNDLE_CHECKOUT_COMING_SOON_NOTICE]) {
      expect(notice).not.toMatch(/paid|buy now|\$/i);
    }
  });
});
