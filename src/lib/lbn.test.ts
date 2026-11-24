import { describe, expect, it } from "vitest";
import { isValidLbn, LBN_ALPHABET, lbnCheckChar, normalizeLbn } from "@/lib/lbn";

// The same vectors as supabase/tests/115_lbn_book_number.test.sql part2,
// so the app and the database agree on every check character.
const SHARED_VECTORS: Array<[string, string, string]> = [
  ["LE", "7K4M9X2", "D"],
  ["LP", "7K4M9X2", "E"],
  ["LE", "2222222", "3"],
  ["LE", "ZZZZZZZ", "6"],
  ["LP", "ABCDEFG", "X"],
];

describe("lbnCheckChar", () => {
  it.each(SHARED_VECTORS)("%s%s -> %s (same as the database)", (prefix, body, check) => {
    expect(lbnCheckChar(prefix, body)).toBe(check);
  });

  it("refuses an unknown prefix, a wrong length or a character outside the alphabet", () => {
    expect(lbnCheckChar("LX", "7K4M9X2")).toBeNull();
    expect(lbnCheckChar("LE", "7K4M9X")).toBeNull();
    expect(lbnCheckChar("LE", "7K4M9X22")).toBeNull();
    for (const bad of ["0", "O", "1", "I", "L", "a"]) {
      expect(lbnCheckChar("LE", `7K4M9X${bad}`)).toBeNull();
    }
  });

  it("uses 31 characters without 0, O, 1, I or L", () => {
    expect(LBN_ALPHABET).toHaveLength(31);
    expect(new Set(LBN_ALPHABET).size).toBe(31);
    expect(LBN_ALPHABET).not.toMatch(/[01OIL]/);
  });
});

describe("isValidLbn", () => {
  it("accepts the shared vectors", () => {
    for (const [prefix, body, check] of SHARED_VECTORS) {
      expect(isValidLbn(`${prefix}${body}${check}`)).toBe(true);
    }
  });

  it.each([
    "le7k4m9x2d",
    "LE7K4M9X2E",
    "LE7K4M9X2",
    "LE7K4M9X2DD",
    "LX7K4M9X2D",
    "LE0K4M9X2D",
    "LEOK4M9X2D",
    " LE7K4M9X2D",
    "",
  ])("refuses %j", (value) => {
    expect(isValidLbn(value)).toBe(false);
  });

  it("catches every one-character change and every swap of two neighbouring random characters", () => {
    const code = "LE7K4M9X2D";
    for (let i = 2; i < 10; i += 1) {
      for (const c of LBN_ALPHABET) {
        const changed = code.slice(0, i) + c + code.slice(i + 1);
        if (changed !== code) expect(isValidLbn(changed)).toBe(false);
      }
    }
    for (let i = 2; i < 8; i += 1) {
      const swapped = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
      if (swapped !== code) expect(isValidLbn(swapped)).toBe(false);
    }
  });
});

describe("normalizeLbn", () => {
  it("accepts small letters and spaces around the code", () => {
    expect(normalizeLbn("le7k4m9x2d")).toBe("LE7K4M9X2D");
    expect(normalizeLbn(" LE7K4M9X2D ")).toBe("LE7K4M9X2D");
  });

  it("refuses anything that is not a valid LBN", () => {
    expect(normalizeLbn("LE7K4M9X2E")).toBeNull();
    expect(normalizeLbn("b0000000-0000-4000-8000-000000000001")).toBeNull();
    expect(normalizeLbn("")).toBeNull();
  });
});
