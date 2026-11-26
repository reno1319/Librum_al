import { describe, expect, it } from "vitest";
import {
  DEFAULT_PICK_BADGE,
  MAX_PICK_BADGE,
  MAX_PICK_NOTE,
  MAX_PICK_QUOTE,
  parsePickForm,
  pickMonthLabel,
  pickStatuses,
} from "./libraria-picks";

// LR1 patch 4: the pure rules behind "Çfarë po lexojmë".
const BOOK = "11111111-1111-4111-8111-111111111111";

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}
const ok = { bookId: BOOK, badge: "", note: "Shënim.", quote: "Citim.", quoteFrom: "book" };

describe("libraria picks: limits", () => {
  it("match the database (migration 20261126090000) and lr4-4 a", () => {
    expect([MAX_PICK_BADGE, MAX_PICK_NOTE, MAX_PICK_QUOTE]).toEqual([24, 400, 240]);
    expect(DEFAULT_PICK_BADGE).toBe("Zgjedhja e Librum");
    expect([...DEFAULT_PICK_BADGE].length).toBeLessThanOrEqual(MAX_PICK_BADGE);
  });
});

describe("pickStatuses", () => {
  it("the newest pick with a listed book is on Libraria, the rest past; an unlisted book hides its pick (lr4-1 a, lr4-3 a)", () => {
    const picks = [
      { id: "p4", book_id: "gone" },
      { id: "p3", book_id: "b3" },
      { id: "p2", book_id: "b2" },
      { id: "p1", book_id: "gone" },
    ];
    const s = pickStatuses(picks, (id) => id !== "gone");
    expect([...s.entries()]).toEqual([
      ["p4", "book_not_live"],
      ["p3", "showing"],
      ["p2", "past"],
      ["p1", "book_not_live"],
    ]);
  });

  it("none listed: none showing", () => {
    expect([...pickStatuses([{ id: "p1", book_id: "x" }], () => false).values()]).toEqual(["book_not_live"]);
  });
});

describe("pickMonthLabel", () => {
  it("names the Tirana month in Albanian", () => {
    expect(pickMonthLabel("2026-11-24T09:00:00Z")).toBe("Nëntor 2026");
    expect(pickMonthLabel("2026-01-01T00:30:00Z")).toBe("Janar 2026");
    expect(pickMonthLabel("2026-12-31T23:30:00Z")).toBe("Janar 2027");
    expect(pickMonthLabel("not a date")).toBe("");
  });
});

describe("parsePickForm", () => {
  it("reads and trims a new pick; empty badge = none", () => {
    expect(parsePickForm(form({ ...ok, note: "  Shënim.  ", quote: " Citim. " }))).toEqual({
      ok: true, pickId: null, bookId: BOOK, badge: null, note: "Shënim.", quote: "Citim.", quoteFrom: "book",
    });
    expect(parsePickForm(form({ ...ok, badge: " Libri i muajit ", quoteFrom: "author" }))).toMatchObject({
      ok: true, badge: "Libri i muajit", quoteFrom: "author",
    });
  });

  it("counts characters, not bytes, at the edges", () => {
    expect(parsePickForm(form({ ...ok, note: "ë".repeat(400), quote: "ç".repeat(240), badge: "ë".repeat(24) })).ok).toBe(true);
    expect(parsePickForm(form({ ...ok, note: "ë".repeat(401) }))).toEqual({ ok: false, reason: "note_long" });
    expect(parsePickForm(form({ ...ok, quote: "ç".repeat(241) }))).toEqual({ ok: false, reason: "quote_long" });
    expect(parsePickForm(form({ ...ok, badge: "ë".repeat(25) }))).toEqual({ ok: false, reason: "badge_long" });
  });

  it.each([
    [{ pickId: "nope" }, "pick"],
    [{ bookId: "nope" }, "book"],
    [{ badge: "a\nb" }, "badge_lines"],
    [{ note: "" }, "note_empty"],
    [{ note: "a\nb" }, "note_lines"],
    [{ quote: "" }, "quote_empty"],
    [{ quote: "a\rb" }, "quote_lines"],
    [{ quoteFrom: "" }, "quote_from"],
  ])("refuses %o", (fields, reason) => {
    expect(parsePickForm(form({ ...ok, ...(fields as Record<string, string>) }))).toEqual({ ok: false, reason });
  });
});
