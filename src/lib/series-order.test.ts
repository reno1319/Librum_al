import { describe, expect, it } from "vitest";
import { orderSeriesBooks, resolveSeriesNeighbors } from "./series-order";

type TestBook = {
  id: string;
  series_position: number | null;
  created_at: string;
};

function book(overrides: Partial<TestBook> & { id: string }): TestBook {
  return {
    series_position: overrides.series_position ?? null,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("orderSeriesBooks", () => {
  it("orders normal positions 1, 2, 3 ascending", () => {
    const books = [
      book({ id: "b3", series_position: 3 }),
      book({ id: "b1", series_position: 1 }),
      book({ id: "b2", series_position: 2 }),
    ];
    expect(orderSeriesBooks(books).map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
  });

  it("puts null positions after every positioned book", () => {
    const books = [
      book({ id: "unpositioned", series_position: null }),
      book({ id: "b2", series_position: 2 }),
      book({ id: "b1", series_position: 1 }),
    ];
    expect(orderSeriesBooks(books).map((b) => b.id)).toEqual(["b1", "b2", "unpositioned"]);
  });

  it("tie-breaks duplicate positions deterministically by created_at ascending", () => {
    const books = [
      book({ id: "later", series_position: 1, created_at: "2026-02-01T00:00:00Z" }),
      book({ id: "earlier", series_position: 1, created_at: "2026-01-01T00:00:00Z" }),
    ];
    expect(orderSeriesBooks(books).map((b) => b.id)).toEqual(["earlier", "later"]);
  });

  it("falls back to id ascending when position and created_at both tie", () => {
    const books = [
      book({ id: "z-book", series_position: 1, created_at: "2026-01-01T00:00:00Z" }),
      book({ id: "a-book", series_position: 1, created_at: "2026-01-01T00:00:00Z" }),
    ];
    expect(orderSeriesBooks(books).map((b) => b.id)).toEqual(["a-book", "z-book"]);
  });

  it("preserves gaps in stored positions rather than renumbering", () => {
    const books = [
      book({ id: "b7", series_position: 7 }),
      book({ id: "b1", series_position: 1 }),
      book({ id: "b3", series_position: 3 }),
    ];
    const ordered = orderSeriesBooks(books);
    expect(ordered.map((b) => b.id)).toEqual(["b1", "b3", "b7"]);
    expect(ordered.map((b) => b.series_position)).toEqual([1, 3, 7]);
  });

  it("handles a single book", () => {
    const books = [book({ id: "only", series_position: 1 })];
    expect(orderSeriesBooks(books).map((b) => b.id)).toEqual(["only"]);
  });

  it("does not mutate the input array", () => {
    const books = [book({ id: "b2", series_position: 2 }), book({ id: "b1", series_position: 1 })];
    const original = [...books];
    orderSeriesBooks(books);
    expect(books).toEqual(original);
  });
});

describe("resolveSeriesNeighbors", () => {
  const ordered = [
    { id: "b1" },
    { id: "b2" },
    { id: "b3" },
  ];

  it("returns no previous for the first book", () => {
    expect(resolveSeriesNeighbors(ordered, "b1")).toEqual({ previous: null, next: { id: "b2" } });
  });

  it("returns no next for the last book", () => {
    expect(resolveSeriesNeighbors(ordered, "b3")).toEqual({ previous: { id: "b2" }, next: null });
  });

  it("returns both previous and next for a middle book", () => {
    expect(resolveSeriesNeighbors(ordered, "b2")).toEqual({
      previous: { id: "b1" },
      next: { id: "b3" },
    });
  });

  it("returns no neighbors for a single-book series", () => {
    expect(resolveSeriesNeighbors([{ id: "only" }], "only")).toEqual({
      previous: null,
      next: null,
    });
  });

  it("returns no neighbors when the current book is absent from the list", () => {
    expect(resolveSeriesNeighbors(ordered, "not-in-list")).toEqual({
      previous: null,
      next: null,
    });
  });
});
