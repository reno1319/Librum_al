import { describe, expect, it } from "vitest";
import { cartCountLabel, cartLineBuyable, cartTotal, lekLabel, readGiftInput } from "./cart";

const book = (over: Partial<{ status: string; price_all: number | null }> = {}) => ({
  id: "b", title: "T", cover_path: null, status: "published", price_all: 299, ...over,
});

describe("readGiftInput (g1 a)", () => {
  it("trims and lower-cases the email; an empty note is no note", () => {
    expect(readGiftInput("  Ana@Example.COM ", "   ")).toEqual({ ok: true, value: { email: "ana@example.com", note: null } });
    expect(readGiftInput("a@b.al", " Gëzuar! ")).toEqual({ ok: true, value: { email: "a@b.al", note: "Gëzuar!" } });
  });
  it("refuses a missing or malformed email", () => {
    for (const bad of [undefined, null, "", "ana", "ana@", "@b.al", "a b@c.al", "a@b", `${"a".repeat(250)}@b.al`]) {
      expect(readGiftInput(bad, null)).toEqual({ ok: false, error: "email" });
    }
  });
  it("allows a note of 300 characters and refuses 301", () => {
    expect(readGiftInput("a@b.al", "x".repeat(300)).ok).toBe(true);
    expect(readGiftInput("a@b.al", "x".repeat(301))).toEqual({ ok: false, error: "note" });
  });
});

describe("cart lines and total", () => {
  it("counts only live, paid books (c3 a)", () => {
    expect(cartLineBuyable(book())).toBe(true);
    expect(cartLineBuyable(book({ price_all: 0 }))).toBe(false);
    expect(cartLineBuyable(book({ price_all: null }))).toBe(false);
    expect(cartLineBuyable(book({ status: "preorder" }))).toBe(false);
    expect(cartLineBuyable(book({ status: "taken_down" }))).toBe(false);
    expect(cartLineBuyable(null)).toBe(false);
    expect(cartTotal([{ book: book() }, { book: book({ price_all: 349 }) }, { book: book({ price_all: 0 }) }, { book: null }])).toBe(648);
    expect(cartTotal([])).toBe(0);
  });
  it("labels", () => {
    expect(lekLabel(897)).toBe("897 lekë");
    expect(lekLabel(1250)).toBe("1.250 lekë");
    expect(cartCountLabel(1)).toBe("1 libër");
    expect(cartCountLabel(3)).toBe("3 libra");
  });
});
