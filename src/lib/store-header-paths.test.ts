import { describe, expect, it } from "vitest";
import { isStoreHeaderPath } from "./store-header-paths";

// HEADER FIX (hd1 a): Libraria and its "Më shumë" page of picks get the
// shop header; every other page gets the normal one.
describe("isStoreHeaderPath", () => {
  it("Libraria and its picks page", () => {
    expect(isStoreHeaderPath("/librari")).toBe(true);
    expect(isStoreHeaderPath("/librari/cfare-po-lexojme")).toBe(true);
  });

  it("every other page, and no path at all", () => {
    for (const p of ["/", "/blog", "/librari/", "/librari/x", "/libra/abc", "/wishlist", "/shporta", "/librarix", ""]) {
      expect(isStoreHeaderPath(p)).toBe(false);
    }
    expect(isStoreHeaderPath(null)).toBe(false);
    expect(isStoreHeaderPath(undefined)).toBe(false);
  });
});
