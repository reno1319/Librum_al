import { describe, expect, it } from "vitest";
import { GENRES } from "@/lib/genres";
import { categoryButtons, NON_FICTION_GENRES, starFills, storeCardAction, summarizeRatings } from "./libraria-store";

describe("LR1 Libraria store rules", () => {
  it("category buttons: the first four categories with books, in A–Zh order, unknown ones ignored", () => {
    expect(categoryButtons(["Romancë", "Horror", "Fantazi", "Biografi & kujtime", "Poezi", "Nope"])).toEqual([
      "Biografi & kujtime",
      "Fantazi",
      "Horror",
      "Poezi",
    ]);
    expect(categoryButtons([])).toEqual([]);
  });

  it("non-fiction is eight known categories", () => {
    expect(NON_FICTION_GENRES).toHaveLength(8);
    for (const g of NON_FICTION_GENRES) expect(GENRES).toContain(g);
  });

  it("ratings: average and count per book, out-of-range ratings skipped, no entry without reviews", () => {
    const m = summarizeRatings([
      { book_id: "a", rating: 5 },
      { book_id: "a", rating: 4 },
      { book_id: "a", rating: 9 },
      { book_id: "b", rating: 0 },
    ]);
    expect(m.get("a")).toEqual({ average: 4.5, count: 2 });
    expect(m.has("b")).toBe(false);
  });

  it("stars round to the nearest half", () => {
    expect(starFills(4.5)).toEqual(["full", "full", "full", "full", "half"]);
    expect(starFills(4.24)).toEqual(["full", "full", "full", "full", "empty"]);
    expect(starFills(4.26)).toEqual(["full", "full", "full", "full", "half"]);
    expect(starFills(1)).toEqual(["full", "empty", "empty", "empty", "empty"]);
    expect(starFills(7)).toEqual(["full", "full", "full", "full", "full"]);
  });

  it("card button: pre-order Shiko librin, free Merre falas, paid Shto (log in / add / in cart)", () => {
    expect(storeCardAction({ status: "preorder", price_all: 299 }, true, false)).toBe("view");
    expect(storeCardAction({ status: "published", price_all: 0 }, true, false)).toBe("free");
    expect(storeCardAction({ status: "published", price_all: 199 }, false, false)).toBe("login");
    expect(storeCardAction({ status: "published", price_all: 199 }, true, false)).toBe("add");
    expect(storeCardAction({ status: "published", price_all: 199 }, true, true)).toBe("in-cart");
    expect(storeCardAction({ status: "published", price_all: null }, true, false)).toBe("view");
    // lr1-12 a: owned or the author's own -> "Shiko librin", paid or free.
    expect(storeCardAction({ status: "published", price_all: 199 }, true, false, true)).toBe("view");
    expect(storeCardAction({ status: "published", price_all: 199 }, true, true, true)).toBe("view");
    expect(storeCardAction({ status: "published", price_all: 0 }, true, false, true)).toBe("view");
    expect(storeCardAction({ status: "published", price_all: 199 }, false, false, true)).toBe("login");
  });
});
