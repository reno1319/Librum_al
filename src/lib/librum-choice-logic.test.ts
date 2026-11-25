import { describe, expect, it } from "vitest";
import { escapeIlikePattern, parseLibrumChoiceSearch } from "./librum-choice-logic";

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
