import { describe, expect, it } from "vitest";
import {
  LIBRUMS_CHOICE_LABEL,
  NEW_ON_LIBRUM_LABEL,
  escapeIlikePattern,
  parseLibrumChoiceSearch,
  resolveBookstoreFeature,
} from "./librum-choice-logic";

describe("resolveBookstoreFeature (settled D7)", () => {
  type B = { id: string; price_all: number | null };
  const newest: B = { id: "new", price_all: 199 };

  it("a priced pick -> Zgjedhja e Librum", () => {
    const pick = { id: "pick", price_all: 499 };
    expect(resolveBookstoreFeature(pick, newest)).toEqual({ book: pick, label: "Zgjedhja e Librum" });
  });

  it("a free pick (0) is priced -> Zgjedhja e Librum", () => {
    const pick = { id: "pick", price_all: 0 };
    expect(resolveBookstoreFeature(pick, newest)?.label).toBe(LIBRUMS_CHOICE_LABEL);
  });

  it("an unpriced pick -> I ri në Librum with the newest book", () => {
    expect(resolveBookstoreFeature<B>({ id: "pick", price_all: null }, newest)).toEqual({
      book: newest,
      label: "I ri në Librum",
    });
  });

  it("no pick -> I ri në Librum with the newest book", () => {
    expect(resolveBookstoreFeature(null, newest)).toEqual({ book: newest, label: NEW_ON_LIBRUM_LABEL });
  });

  it("no newest book and no usable pick -> no block", () => {
    expect(resolveBookstoreFeature(null, null)).toBeNull();
    expect(resolveBookstoreFeature<B>({ id: "pick", price_all: null }, null)).toBeNull();
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
