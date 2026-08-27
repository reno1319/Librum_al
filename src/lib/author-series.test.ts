import { describe, expect, it } from "vitest";
import { groupPublishedBooksBySeries } from "./author-series";

type TestBook = {
  id: string;
  title: string;
  cover_path: string | null;
  series_id: string | null;
  series_position: number | null;
};

function book(overrides: Partial<TestBook> & { id: string }): TestBook {
  return {
    title: overrides.title ?? `Book ${overrides.id}`,
    cover_path: overrides.cover_path ?? null,
    series_id: overrides.series_id ?? null,
    series_position: overrides.series_position ?? null,
    ...overrides,
  };
}

describe("groupPublishedBooksBySeries", () => {
  it("returns nothing when no book belongs to a series", () => {
    const books = [book({ id: "b1" }), book({ id: "b2" })];
    expect(groupPublishedBooksBySeries(books, [])).toEqual([]);
  });

  it("groups books by series_id and counts members", () => {
    const books = [
      book({ id: "b1", series_id: "s1", series_position: 1 }),
      book({ id: "b2", series_id: "s1", series_position: 2 }),
      book({ id: "b3", series_id: null }),
    ];
    const series = [{ id: "s1", title: "The Ashfall Trilogy" }];

    const groups = groupPublishedBooksBySeries(books, series);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      id: "s1",
      title: "The Ashfall Trilogy",
      bookCount: 2,
    });
  });

  it("orders each series' covers by series_position, nulls last", () => {
    const books = [
      book({ id: "b1", series_id: "s1", series_position: 3 }),
      book({ id: "b2", series_id: "s1", series_position: null }),
      book({ id: "b3", series_id: "s1", series_position: 1 }),
    ];
    const series = [{ id: "s1", title: "Series One" }];

    const [group] = groupPublishedBooksBySeries(books, series);

    expect(group.covers.map((c) => c.id)).toEqual(["b3", "b1", "b2"]);
  });

  it("caps the cover strip at 4 books without dropping bookCount", () => {
    const books = Array.from({ length: 7 }, (_, i) =>
      book({ id: `b${i}`, series_id: "s1", series_position: i + 1 }),
    );
    const series = [{ id: "s1", title: "Long Series" }];

    const [group] = groupPublishedBooksBySeries(books, series);

    expect(group.bookCount).toBe(7);
    expect(group.covers).toHaveLength(4);
    expect(group.covers.map((c) => c.id)).toEqual(["b0", "b1", "b2", "b3"]);
  });

  it("drops a book whose series_id has no matching series row rather than showing a blank title", () => {
    const books = [book({ id: "b1", series_id: "missing-series" })];

    expect(groupPublishedBooksBySeries(books, [])).toEqual([]);
  });

  it("preserves multiple series in first-appearance (newest-first) order", () => {
    const books = [
      book({ id: "b1", series_id: "s-newer" }),
      book({ id: "b2", series_id: "s-older" }),
      book({ id: "b3", series_id: "s-newer" }),
    ];
    const series = [
      { id: "s-newer", title: "Newer Series" },
      { id: "s-older", title: "Older Series" },
    ];

    const groups = groupPublishedBooksBySeries(books, series);

    expect(groups.map((g) => g.id)).toEqual(["s-newer", "s-older"]);
  });
});
