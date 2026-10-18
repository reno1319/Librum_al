import { describe, expect, it } from "vitest";
import {
  LIBRUMS_CHOICE_LABEL,
  NEW_ON_LIBRUM_LABEL,
  escapeIlikePattern,
  orderHomepageBooks,
  parseLibrumChoiceSearch,
  qualifiesForHomepage,
  resolveBookstoreFeature,
} from "./librum-choice-logic";

describe("resolveBookstoreFeature (settled D7)", () => {
  type B = { id: string; price_all: number | null };
  const newest: B = { id: "new", price_all: 199 };

  it("a priced pick -> Librum's choice", () => {
    const pick = { id: "pick", price_all: 499 };
    expect(resolveBookstoreFeature(pick, newest)).toEqual({ book: pick, label: "Librum's choice" });
  });

  it("a free pick (0) is priced -> Librum's choice", () => {
    const pick = { id: "pick", price_all: 0 };
    expect(resolveBookstoreFeature(pick, newest)?.label).toBe(LIBRUMS_CHOICE_LABEL);
  });

  it("an unpriced pick -> New on Librum with the newest book", () => {
    expect(resolveBookstoreFeature<B>({ id: "pick", price_all: null }, newest)).toEqual({
      book: newest,
      label: "New on Librum",
    });
  });

  it("no pick -> New on Librum with the newest book", () => {
    expect(resolveBookstoreFeature(null, newest)).toEqual({ book: newest, label: NEW_ON_LIBRUM_LABEL });
  });

  it("no newest book and no usable pick -> no block", () => {
    expect(resolveBookstoreFeature(null, null)).toBeNull();
    expect(resolveBookstoreFeature<B>({ id: "pick", price_all: null }, null)).toBeNull();
  });
});

describe("qualifiesForHomepage (fetchPublishedCovers' own filter)", () => {
  const base = { status: "published", price_all: 199, cover_path: "a/b.png" };
  it("published, priced, with a cover -> yes (0 = free counts)", () => {
    expect(qualifiesForHomepage(base)).toBe(true);
    expect(qualifiesForHomepage({ ...base, price_all: 0 })).toBe(true);
  });
  it("no price, no cover or not published -> no", () => {
    expect(qualifiesForHomepage({ ...base, price_all: null })).toBe(false);
    expect(qualifiesForHomepage({ ...base, cover_path: null })).toBe(false);
    expect(qualifiesForHomepage({ ...base, status: "draft" })).toBe(false);
  });
});

describe("orderHomepageBooks (Q2 = b)", () => {
  const books = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i + 1}` }));
  const ids = (list: { id: string }[]) => list.map((b) => b.id);

  it("no pick -> the newest list unchanged", () => {
    const list = books(8);
    expect(orderHomepageBooks(list, null)).toBe(list);
  });

  it("a pick among the newest moves to the front, once", () => {
    expect(ids(orderHomepageBooks(books(8), { id: "n6" }))).toEqual(["n6", "n1", "n2", "n3", "n4", "n5", "n7", "n8"]);
  });

  it("a pick older than the newest goes in front of them", () => {
    expect(ids(orderHomepageBooks(books(8), { id: "old" }))).toEqual(["old", "n1", "n2", "n3", "n4", "n5", "n6", "n7", "n8"]);
  });

  it("fewer than 5 books: the pick still leads (the page shows the photo below 5)", () => {
    expect(ids(orderHomepageBooks(books(3), { id: "old" }))).toEqual(["old", "n1", "n2", "n3"]);
  });

  it("never the same book twice", () => {
    const out = ids(orderHomepageBooks(books(8), { id: "n1" }));
    expect(new Set(out).size).toBe(out.length);
    expect(out[0]).toBe("n1");
  });
});

describe("admin search input", () => {
  it("trims and caps at 100 characters; anything else is empty", () => {
    expect(parseLibrumChoiceSearch("  Kështjella  ")).toBe("Kështjella");
    expect(parseLibrumChoiceSearch("x".repeat(150))).toHaveLength(100);
    expect(parseLibrumChoiceSearch(["first", "second"])).toBe("first");
    expect(parseLibrumChoiceSearch(undefined)).toBe("");
  });

  it("escapes %, _ and \\ so they match themselves", () => {
    expect(escapeIlikePattern("100%_done\\")).toBe("100\\%\\_done\\\\");
    expect(escapeIlikePattern("plain")).toBe("plain");
  });
});
