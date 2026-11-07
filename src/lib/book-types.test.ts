import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BOOK_TYPES, bookEyebrow, bookTypeOf, isBookType } from "./book-types";

describe("BOOK_TYPES", () => {
  it("is the eight types Renato agreed (11-06), NFC, in that order", () => {
    expect(BOOK_TYPES).toEqual([
      "Roman",
      "Novelë / tregim",
      "Përmbledhje me tregime",
      "Poezi",
      "Dramë",
      "Ese",
      "Biografi & kujtime",
      "Jo-artistik (studim, tjetër)",
    ]);
    for (const t of BOOK_TYPES) expect(t).toBe(t.normalize("NFC"));
  });

  it("equals the database CHECK, in schema.sql and in the migration", () => {
    for (const file of ["supabase/schema.sql", "supabase/migrations/20261107120000_book_type.sql"]) {
      const sql = readFileSync(file, "utf8");
      const block = sql.match(/constraint books_book_type_check check \(book_type in \(([\s\S]*?)\)\);/);
      expect(block, file).not.toBeNull();
      const values = Array.from(block![1].matchAll(/'([^']*)'/g), (m) => m[1]);
      expect(values, file).toEqual([...BOOK_TYPES]);
    }
  });
});

describe("bookTypeOf / isBookType", () => {
  it("takes only a value on the list", () => {
    expect(isBookType("Ese")).toBe(true);
    expect(isBookType("ese")).toBe(false);
    expect(isBookType(null)).toBe(false);
    expect(bookTypeOf({ book_type: "Poezi" })).toBe("Poezi");
    expect(bookTypeOf({ book_type: "Tregime" })).toBeNull();
    expect(bookTypeOf({})).toBeNull();
  });
});

describe("bookEyebrow", () => {
  it("shows the type, then the genre", () => {
    expect(bookEyebrow({ book_type: "Roman", genre: "Horror" })).toBe("Roman · Horror");
  });
  it("shows the genre alone while there is no type, and the type alone with no genre", () => {
    expect(bookEyebrow({ book_type: null, genre: "Horror" })).toBe("Horror");
    expect(bookEyebrow({ book_type: "Ese", genre: null })).toBe("Ese");
    expect(bookEyebrow({ book_type: null, genre: "  " })).toBeNull();
    expect(bookEyebrow({})).toBeNull();
  });
  it("never repeats the same word", () => {
    expect(bookEyebrow({ book_type: "Poezi", genre: "Poezi" })).toBe("Poezi");
    expect(bookEyebrow({ book_type: "Biografi & kujtime", genre: "Biografi & kujtime" })).toBe("Biografi & kujtime");
  });
  it("ignores a stored type that is not on the list", () => {
    expect(bookEyebrow({ book_type: "Tregime", genre: "Horror" })).toBe("Horror");
  });
});
