import { describe, expect, it } from "vitest";
import { getAuthorInitials } from "./author-initials";

describe("getAuthorInitials", () => {
  it("returns the first initial for a one-word name", () => {
    expect(getAuthorInitials("Elira")).toBe("E");
  });

  it("returns first + last initial for a two-word name", () => {
    expect(getAuthorInitials("Blerim Hoxha")).toBe("BH");
  });

  it("uses the first and last word for a name with more than two words", () => {
    expect(getAuthorInitials("Maria de la Cruz")).toBe("MC");
  });

  it("uppercases initials regardless of input case", () => {
    expect(getAuthorInitials("elira kastrati")).toBe("EK");
  });

  it("collapses repeated internal whitespace", () => {
    expect(getAuthorInitials("Elira   Kastrati")).toBe("EK");
  });

  it("returns an empty string for an empty name", () => {
    expect(getAuthorInitials("")).toBe("");
  });

  it("returns an empty string for a whitespace-only name", () => {
    expect(getAuthorInitials("   ")).toBe("");
  });
});

// LEFTOVERS (L3): punctuation, digits and emoji never become an initial.
describe("getAuthorInitials: letters only", () => {
  it.each([
    ["Ana (local)", "AL"],
    ["Ana Brati –", "AB"],
    ["– Ana", "A"],
    ['"Ana" Brati', "AB"],
    ["'Ana", "A"],
    ["3Dana", "D"],
    ["😀", ""],
    ["😀 Ana", "A"],
    ["\u00C9lan \u00C7ela", "\u00C9\u00C7"], // composed
    ["E\u0301lan C\u0327ela", "\u00C9\u00C7"], // decomposed: NFC first
  ])("%s -> %s", (name, initials) => {
    expect(getAuthorInitials(name)).toBe(initials);
  });
});
