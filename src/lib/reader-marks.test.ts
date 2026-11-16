import { describe, expect, it } from "vitest";
import { cleanNote, parseMarksData, parseMarksOp, toMarkHighlights } from "@/lib/reader-marks";

const ID = "c0000000-0000-4000-8000-000000000001";

describe("parseMarksOp", () => {
  it("place: an offset and a share 0..1 (rounded to 4 places)", () => {
    expect(parseMarksOp({ op: "place", offset: 120, progress: 0.123456 })).toEqual({ op: "place", offset: 120, progress: 0.1235 });
    expect(parseMarksOp({ op: "place", offset: -1, progress: 0.1 })).toBeNull();
    expect(parseMarksOp({ op: "place", offset: 1.5, progress: 0.1 })).toBeNull();
    expect(parseMarksOp({ op: "place", offset: 1, progress: 1.01 })).toBeNull();
  });
  it("bookmarks: add one offset; remove 1..50 ids", () => {
    expect(parseMarksOp({ op: "bookmark_add", offset: 5 })).toEqual({ op: "bookmark_add", offset: 5 });
    expect(parseMarksOp({ op: "bookmark_remove", ids: [ID] })).toEqual({ op: "bookmark_remove", ids: [ID] });
    expect(parseMarksOp({ op: "bookmark_remove", ids: [] })).toBeNull();
    expect(parseMarksOp({ op: "bookmark_remove", ids: ["x"] })).toBeNull();
    expect(parseMarksOp({ op: "bookmark_remove", ids: Array(51).fill(ID) })).toBeNull();
  });
  it("highlight_add: the words must match the span; 4 colours; note ≤ 1,000", () => {
    const ok = { op: "highlight_add", start: 10, end: 14, quote: "abcd", prefix: "x", suffix: "y", color: "green" };
    expect(parseMarksOp(ok)).toEqual({ ...ok, note: null });
    expect(parseMarksOp({ ...ok, quote: "abc" })).toBeNull();
    expect(parseMarksOp({ ...ok, color: "red" })).toBeNull();
    expect(parseMarksOp({ ...ok, end: 10, quote: "" })).toBeNull();
    expect(parseMarksOp({ ...ok, prefix: "p".repeat(65) })).toBeNull();
    expect(parseMarksOp({ ...ok, note: "  Shënim  " })).toEqual({ ...ok, note: "Shënim" });
    expect(parseMarksOp({ ...ok, note: "n".repeat(1001) })).toBeNull();
  });
  it("highlight_update needs a colour or a note; an empty note clears it", () => {
    expect(parseMarksOp({ op: "highlight_update", id: ID })).toBeNull();
    expect(parseMarksOp({ op: "highlight_update", id: ID, color: "pink" })).toEqual({ op: "highlight_update", id: ID, color: "pink" });
    expect(parseMarksOp({ op: "highlight_update", id: ID, note: "   " })).toEqual({ op: "highlight_update", id: ID, note: null });
    expect(parseMarksOp({ op: "highlight_update", id: "nope", color: "pink" })).toBeNull();
  });
  it("reanchor: moves and not-found ids, at least one, at most 3,000", () => {
    expect(parseMarksOp({ op: "reanchor", moves: [{ id: ID, start: 1, end: 3 }], orphaned: [] })).toEqual({
      op: "reanchor",
      moves: [{ id: ID, start: 1, end: 3 }],
      orphaned: [],
    });
    expect(parseMarksOp({ op: "reanchor", moves: [], orphaned: [] })).toBeNull();
    expect(parseMarksOp({ op: "reanchor", moves: [{ id: ID, start: 3, end: 3 }], orphaned: [] })).toBeNull();
    expect(parseMarksOp({ op: "reanchor", moves: [], orphaned: Array(3001).fill(ID) })).toBeNull();
  });
  it("anything else is refused", () => {
    for (const bad of [null, [], "x", { op: "copy" }, { op: "highlight_remove", id: 1 }]) expect(parseMarksOp(bad)).toBeNull();
  });
});

describe("rows and answers", () => {
  it("cleanNote", () => {
    expect(cleanNote(null)).toBeNull();
    expect(cleanNote("")).toBeNull();
    expect(cleanNote(5)).toBeUndefined();
  });
  it("toMarkHighlights keeps good rows, sorted, with orphaned as a flag", () => {
    const rows = [
      { id: ID, start_offset: 9, end_offset: 12, quote: "abc", prefix: "", suffix: "", color: "blue", note: null, orphaned_at: "2026-11-15T10:00:00Z" },
      { id: "c0000000-0000-4000-8000-000000000002", start_offset: 1, end_offset: 2, quote: "a", prefix: "", suffix: "", color: "yellow", note: "n", orphaned_at: null },
      { id: "bad", start_offset: 1, end_offset: 2, quote: "a", color: "yellow" },
    ];
    const out = toMarkHighlights(rows);
    expect(out.map((h) => [h.start, h.orphaned])).toEqual([
      [1, false],
      [9, true],
    ]);
  });
  it("parseMarksData drops what doesn't fit and refuses a non-answer", () => {
    expect(parseMarksData(null)).toBeNull();
    expect(parseMarksData({ place: null, bookmarks: [{ id: ID, offset: -1 }], highlights: [] })).toEqual({ place: null, bookmarks: [], highlights: [] });
  });
});
