import { describe, expect, it } from "vitest";
import {
  escapeIlikePattern,
  librumChoicePageHref,
  parseLibrumChoicePage,
  parseLibrumChoiceSearch,
} from "./librum-choice-logic";

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

describe("book list pages", () => {
  it("parseLibrumChoicePage: plain whole numbers from 1; anything else is page 1", () => {
    expect(parseLibrumChoicePage(undefined)).toBe(1);
    expect(parseLibrumChoicePage("1")).toBe(1);
    expect(parseLibrumChoicePage("3")).toBe(3);
    expect(parseLibrumChoicePage(["2", "5"])).toBe(2);
    for (const bad of ["0", "-1", "2abc", "1.5", "", " 2", "1234567", "abc"]) expect(parseLibrumChoicePage(bad)).toBe(1);
  });

  it("librumChoicePageHref keeps the search and leaves ?page off page 1", () => {
    expect(librumChoicePageHref("", 1)).toBe("/admin/librum-choice");
    expect(librumChoicePageHref("", 2)).toBe("/admin/librum-choice?page=2");
    expect(librumChoicePageHref("Ura e & ?", 3)).toBe("/admin/librum-choice?q=Ura+e+%26+%3F&page=3");
    expect(librumChoicePageHref("Ura", 1)).toBe("/admin/librum-choice?q=Ura");
  });
});
