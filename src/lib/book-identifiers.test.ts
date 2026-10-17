import { describe, expect, it } from "vitest";
import { isFutureDateString, isValidIsbn } from "@/lib/book-identifiers";

describe("isValidIsbn", () => {
  it("accepts real ISBN-13s, with or without hyphens and spaces", () => {
    expect(isValidIsbn("978-3-16-148410-0")).toBe(true);
    expect(isValidIsbn("9783161484100")).toBe(true);
    expect(isValidIsbn("978 3 16 148410 0")).toBe(true);
    expect(isValidIsbn("979-10-90636-07-1")).toBe(true);
  });

  it("accepts real ISBN-10s, including an X check digit in either case", () => {
    expect(isValidIsbn("0-306-40615-2")).toBe(true);
    expect(isValidIsbn("0306406152")).toBe(true);
    expect(isValidIsbn("0-8044-2957-X")).toBe(true);
    expect(isValidIsbn("080442957x")).toBe(true);
  });

  it("rejects a wrong check digit", () => {
    expect(isValidIsbn("978-3-16-148410-1")).toBe(false);
    expect(isValidIsbn("0-306-40615-3")).toBe(false);
  });

  it("rejects the wrong length, letters, and an X anywhere but the ISBN-10 end", () => {
    expect(isValidIsbn("12345")).toBe(false);
    expect(isValidIsbn("97831614841")).toBe(false);
    expect(isValidIsbn("ISBN 9783161484100")).toBe(false);
    expect(isValidIsbn("X306406152")).toBe(false);
    expect(isValidIsbn("978316148410X")).toBe(false);
    expect(isValidIsbn("")).toBe(false);
  });

  it("rejects a valid EAN-13 that is not a book number", () => {
    // Checksum-valid, but not 978/979.
    expect(isValidIsbn("4006381333931")).toBe(false);
  });
});

describe("isFutureDateString", () => {
  const now = new Date("2026-10-17T18:00:00.000Z");

  it("today and earlier are not in the future", () => {
    expect(isFutureDateString("2026-10-17", now)).toBe(false);
    expect(isFutureDateString("2026-10-16", now)).toBe(false);
    expect(isFutureDateString("1999-01-01", now)).toBe(false);
  });

  it("tomorrow and later are in the future", () => {
    expect(isFutureDateString("2026-10-18", now)).toBe(true);
    expect(isFutureDateString("2030-01-01", now)).toBe(true);
  });

  it("uses the UTC date, the same line the server draws", () => {
    // 23:30 UTC on the 17th is already the 18th in Tirana; the server
    // still refuses the 18th, so the wizard must too.
    expect(isFutureDateString("2026-10-18", new Date("2026-10-17T23:30:00.000Z"))).toBe(true);
  });

  it("is false for anything that isn't a YYYY-MM-DD date (left to the server's own check)", () => {
    expect(isFutureDateString("", now)).toBe(false);
    expect(isFutureDateString("18/10/2030", now)).toBe(false);
  });
});
