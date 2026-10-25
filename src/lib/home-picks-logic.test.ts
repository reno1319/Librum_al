import { describe, expect, it } from "vitest";
import {
  fanDrawOrder,
  parseHomeSlot,
  pickShowcaseBooks,
  qualifiesForHomeFan,
  resolveHomeFan,
  type HomeSlotRow,
} from "./home-picks-logic";

// HOME-PICKS-1: the cover fan's slot and fallback rules.
type B = { id: string };
const books = (n: number, prefix = "n") => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}` }));
const picks = (...ids: string[]) => new Map<string, B>(ids.map((id) => [id, { id }]));
const row = (slot: number, book_id: string, sponsored = false): HomeSlotRow => ({ slot, book_id, sponsored });
const shape = (fan: { slot: number; book: B; sponsored: boolean }[]) =>
  fan.map((c) => `${c.slot}:${c.book.id}${c.sponsored ? "*" : ""}`);

describe("qualifiesForHomeFan (the home list's own filter)", () => {
  const base = { status: "published", price_all: 199, cover_path: "a/cover.png" };
  it("published, priced, with a cover -> yes (0 = free counts)", () => {
    expect(qualifiesForHomeFan(base)).toBe(true);
    expect(qualifiesForHomeFan({ ...base, price_all: 0 })).toBe(true);
  });
  it("no price, no cover or not published -> no", () => {
    expect(qualifiesForHomeFan({ ...base, price_all: null })).toBe(false);
    expect(qualifiesForHomeFan({ ...base, cover_path: null })).toBe(false);
    expect(qualifiesForHomeFan({ ...base, status: "draft" })).toBe(false);
  });
});

describe("resolveHomeFan", () => {
  it("no slots filled -> the three newest books, in slot order, none sponsored", () => {
    expect(shape(resolveHomeFan([], picks(), books(8)))).toEqual(["1:n1", "2:n2", "3:n3"]);
  });

  it("all three slots filled -> exactly the picks, with their ticks", () => {
    const slots = [row(1, "p1", true), row(2, "p2"), row(3, "p3", true)];
    expect(shape(resolveHomeFan(slots, picks("p1", "p2", "p3"), books(8)))).toEqual(["1:p1*", "2:p2", "3:p3*"]);
  });

  it("an empty slot falls back to the newest book not already shown", () => {
    const slots = [row(1, "n1"), row(3, "p3")];
    expect(shape(resolveHomeFan(slots, picks("n1", "p3"), books(8)))).toEqual(["1:n1", "2:n2", "3:p3"]);
  });

  it("a slot whose book is no longer live (unpublished, taken down, in review, no cover) falls back", () => {
    // The page only returns live picks in `picked`; p2 is missing.
    const slots = [row(1, "p1"), row(2, "p2", true), row(3, "p3")];
    expect(shape(resolveHomeFan(slots, picks("p1", "p3"), books(8)))).toEqual(["1:p1", "2:n1", "3:p3"]);
  });

  it("a fallback book never carries the Sponsored tag of the slot it fills", () => {
    const fan = resolveHomeFan([row(2, "gone", true)], picks(), books(8));
    expect(fan.every((c) => !c.sponsored)).toBe(true);
  });

  it("a pick that is also among the newest is not shown twice", () => {
    const slots = [row(2, "n1")];
    const fan = resolveHomeFan(slots, picks("n1"), books(8));
    expect(shape(fan)).toEqual(["1:n2", "2:n1", "3:n3"]);
    expect(new Set(fan.map((c) => c.book.id)).size).toBe(3);
  });

  it("the same book in two rows (refused by the database) is still shown once", () => {
    const slots = [row(1, "p1"), row(2, "p1")];
    expect(shape(resolveHomeFan(slots, picks("p1"), books(8)))).toEqual(["1:p1", "2:n1", "3:n2"]);
  });

  it("rows for slots outside 1-3 are ignored", () => {
    expect(shape(resolveHomeFan([row(4, "p4")], picks("p4"), books(8)))).toEqual(["1:n1", "2:n2", "3:n3"]);
  });

  it("fewer than three live books in all -> [] (the hero shows its photograph)", () => {
    expect(resolveHomeFan([], picks(), books(2))).toEqual([]);
    expect(resolveHomeFan([row(1, "p1")], picks("p1"), [{ id: "p1" }])).toEqual([]);
  });

  it("two picks plus one newest book is enough", () => {
    const slots = [row(1, "p1"), row(3, "p3")];
    expect(shape(resolveHomeFan(slots, picks("p1", "p3"), books(1)))).toEqual(["1:p1", "2:n1", "3:p3"]);
  });
});

describe("fanDrawOrder", () => {
  it("draws slot 2 left, slot 1 in the middle, slot 3 right", () => {
    const fan = resolveHomeFan([], picks(), books(3));
    expect(fanDrawOrder(fan).map((c) => c.slot)).toEqual([2, 1, 3]);
  });
});

describe("pickShowcaseBooks (Published with Librum, 3a)", () => {
  const ids = (list: B[]) => list.map((b) => b.id);
  it("skips the fan's books while three others exist", () => {
    expect(ids(pickShowcaseBooks(books(8), books(3)))).toEqual(["n4", "n5", "n6"]);
  });
  it("staff picks outside the newest list leave the newest books for the showcase", () => {
    expect(ids(pickShowcaseBooks(books(8), books(3, "p")))).toEqual(["n1", "n2", "n3"]);
  });
  it("tops up with fan books, in slot order, when too few others exist", () => {
    expect(ids(pickShowcaseBooks(books(4), books(3)))).toEqual(["n4", "n1", "n2"]);
    expect(ids(pickShowcaseBooks(books(3), books(3)))).toEqual(["n1", "n2", "n3"]);
  });
  it("no fan (fewer than three books) -> the newest books", () => {
    expect(ids(pickShowcaseBooks(books(2), []))).toEqual(["n1", "n2"]);
  });
});

describe("parseHomeSlot", () => {
  it("accepts exactly 1, 2 and 3", () => {
    expect(parseHomeSlot("1")).toBe(1);
    expect(parseHomeSlot("2")).toBe(2);
    expect(parseHomeSlot("3")).toBe(3);
  });
  it("refuses anything else", () => {
    for (const raw of ["0", "4", "01", "1.0", " 1", "", "x", null, undefined, 1, ["1"]]) {
      expect(parseHomeSlot(raw)).toBeNull();
    }
  });
});
