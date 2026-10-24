import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SELLER, SELLER_PENDING_TEXT, isSellerRegistered } from "./seller";
import { SellerDetailsBlock } from "@/components/seller-details";

// POLICY PAGES (4. a): company details show only when all four exist.
const full = { name: "Librum SHPK", nipt: "L00000000A", address: "Rruga X, Tirana", phone: "+355 600 000 000" };

describe("POLICY PAGES: seller details", () => {
  it("is empty until the company is registered", () => {
    expect(isSellerRegistered()).toBe(false);
    expect(SELLER).toEqual({ name: "", nipt: "", address: "", phone: "" });
  });

  it("needs all four fields", () => {
    expect(isSellerRegistered(full)).toBe(true);
    for (const key of Object.keys(full) as (keyof typeof full)[]) {
      expect(isSellerRegistered({ ...full, [key]: "  " })).toBe(false);
    }
  });

  it("shows the pending sentence, then the details", () => {
    expect(renderToStaticMarkup(SellerDetailsBlock({}))).toContain(SELLER_PENDING_TEXT.replace(/'/g, "&#x27;"));
    const html = renderToStaticMarkup(SellerDetailsBlock({ seller: full }));
    for (const value of Object.values(full)) expect(html).toContain(value);
    expect(html).not.toContain("will be added");
  });
});
