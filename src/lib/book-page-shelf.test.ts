import { describe, expect, it } from "vitest";
import { isNewOnLibrum, NEW_BOOK_DAYS, sameBookIds, shelfPage, shelfPageText } from "./book-page-shelf";
import { activeSection } from "@/components/book-page-section-bar";

const NOW = new Date("2026-11-28T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const DAY = 86_400_000;

describe("isNewOnLibrum (bp5 a: 30 days)", () => {
  it("a live book published under 30 days ago is new", () => {
    expect(NEW_BOOK_DAYS).toBe(30);
    expect(isNewOnLibrum({ status: "published", published_at: ago(0) }, NOW)).toBe(true);
    expect(isNewOnLibrum({ status: "published", published_at: ago(30 * DAY - 1) }, NOW)).toBe(true);
  });
  it("30 days or older is not", () => {
    expect(isNewOnLibrum({ status: "published", published_at: ago(30 * DAY) }, NOW)).toBe(false);
  });
  it("never a pre-order, a draft, a missing or bad date, or a date in the future", () => {
    expect(isNewOnLibrum({ status: "preorder", published_at: ago(DAY) }, NOW)).toBe(false);
    expect(isNewOnLibrum({ status: "draft", published_at: ago(DAY) }, NOW)).toBe(false);
    expect(isNewOnLibrum({ status: "published", published_at: null }, NOW)).toBe(false);
    expect(isNewOnLibrum({ status: "published", published_at: "nope" }, NOW)).toBe(false);
    expect(isNewOnLibrum({ status: "published", published_at: ago(-DAY) }, NOW)).toBe(false);
  });
});

describe("sameBookIds", () => {
  it("same books in the same order only", () => {
    expect(sameBookIds([{ id: "a" }, { id: "b" }], [{ id: "a" }, { id: "b" }])).toBe(true);
    expect(sameBookIds([{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "a" }])).toBe(false);
    expect(sameBookIds([{ id: "a" }], [{ id: "a" }, { id: "b" }])).toBe(false);
  });
});

describe('"Faqja X nga Y" (item 23)', () => {
  it("counts pages of the visible width, the last one at the row's end", () => {
    expect(shelfPage(0, 1000, 3000)).toEqual({ page: 1, total: 3 });
    expect(shelfPage(1000, 1000, 3000)).toEqual({ page: 2, total: 3 });
    expect(shelfPage(1700, 1000, 2700)).toEqual({ page: 3, total: 3 });
    expect(shelfPage(0, 1000, 900)).toEqual({ page: 1, total: 1 });
    expect(shelfPage(0, 0, 0)).toEqual({ page: 1, total: 1 });
    expect(shelfPageText({ page: 1, total: 3 })).toBe("Faqja 1 nga 3");
  });
});

describe("the section bar's current part (item 13)", () => {
  it("the last part whose top passed under the bar; none above the first", () => {
    const tops = [
      { id: "a", top: 300 },
      { id: "b", top: 900 },
    ];
    expect(activeSection(tops, 64)).toBeNull();
    expect(activeSection([{ id: "a", top: 60 }, { id: "b", top: 700 }], 64)).toBe("a");
    expect(activeSection([{ id: "a", top: -500 }, { id: "b", top: 40 }], 64)).toBe("b");
  });
});
