import { describe, expect, it } from "vitest";
import {
  SHELF_FILTERS,
  SHELF_STATE_COPY,
  groupShelfBooks,
  matchesShelfFilter,
  parseShelfQuery,
  resolveShelfState,
  shelfHref,
  shelfMenuItems,
  sortShelfBooks,
  type ShelfBook,
  type ShelfFacts,
  type ShelfState,
} from "./bookshelf";

// BD15 P6: the bookshelf's states, menu, toolbar and grouping
// (PLAN-BD15-r1 §2.1; Renato 11-05 Q1 a, Q2 a, Q3 a).

const SENT_BACK = { sentBackAt: "2026-10-19T10:00:00Z", reason: "broken_file", message: "x" };
const NONE: ShelfFacts = { takenDown: false, review: null, hasPendingChanges: false, pendingSentBack: false };
const ALL_STATES = Object.keys(SHELF_STATE_COPY) as ShelfState[];

describe("resolveShelfState", () => {
  const draft = { status: "draft" };
  const live = { status: "published" };

  it("drafts: plain, in review, sent back; review outranks an older send back", () => {
    expect(resolveShelfState(draft, NONE)).toBe("draft");
    expect(resolveShelfState(draft, { ...NONE, review: { inReview: true, sentBack: null } })).toBe("in_review");
    expect(resolveShelfState(draft, { ...NONE, review: { inReview: false, sentBack: SENT_BACK } })).toBe("sent_back");
    expect(resolveShelfState(draft, { ...NONE, review: { inReview: true, sentBack: SENT_BACK } })).toBe("in_review");
  });

  it("a takedown outranks everything", () => {
    for (const book of [draft, live]) {
      expect(
        resolveShelfState(book, {
          takenDown: true,
          review: { inReview: true, sentBack: SENT_BACK },
          hasPendingChanges: true,
          pendingSentBack: true,
        }),
      ).toBe("taken_down");
    }
  });

  it("live: plain, waiting changes, changes in review, changes sent back", () => {
    expect(resolveShelfState(live, NONE)).toBe("live");
    expect(resolveShelfState(live, { ...NONE, hasPendingChanges: true })).toBe("live_changes");
    expect(resolveShelfState(live, { ...NONE, review: { inReview: true, sentBack: null } })).toBe("live_in_review");
    expect(
      resolveShelfState(live, {
        ...NONE,
        review: { inReview: false, sentBack: SENT_BACK },
        hasPendingChanges: true,
        pendingSentBack: true,
      }),
    ).toBe("live_sent_back");
  });

  it("a live send back counts only while the changes it was about still wait", () => {
    const review = { inReview: false, sentBack: SENT_BACK };
    // Discarded: nothing waits.
    expect(resolveShelfState(live, { ...NONE, review })).toBe("live");
    // Discarded, then new changes saved after the send back.
    expect(resolveShelfState(live, { ...NONE, review, hasPendingChanges: true, pendingSentBack: false })).toBe("live_changes");
  });
});

describe("SHELF_STATE_COPY", () => {
  it("each state has one label and one main button (plan §2.1)", () => {
    expect(SHELF_STATE_COPY.draft.button).toBe("Vazhdoni përgatitjen");
    expect(SHELF_STATE_COPY.in_review.button).toBe("Shikoni çfarë dërguat");
    expect(SHELF_STATE_COPY.live.action).toBe("book_page");
    expect(SHELF_STATE_COPY.live_changes.button).toBe("Vazhdoni ndryshimet");
    expect(SHELF_STATE_COPY.taken_down.button).toBe("Shikoni arsyen");
    for (const state of ALL_STATES) {
      expect(SHELF_STATE_COPY[state].label.length).toBeGreaterThan(0);
      expect(SHELF_STATE_COPY[state].button.length).toBeGreaterThan(0);
    }
  });

  it("only the live states with waiting or sent changes carry the readers line", () => {
    const withLine = ALL_STATES.filter((state) => SHELF_STATE_COPY[state].line !== null);
    expect(withLine.sort()).toEqual(["live_changes", "live_in_review", "live_sent_back"]);
  });
});

describe("shelfMenuItems", () => {
  const items = (state: ShelfState, status: string, hasFile = true) => shelfMenuItems({ state, status, hasFile });

  it("Q3 a: Delete never on a live book, always on one that is not live", () => {
    for (const state of ["live", "live_changes", "live_in_review", "live_sent_back"] as const) {
      expect(items(state, "published")).not.toContain("delete");
      expect(items(state, "published")).toContain("unpublish");
    }
    for (const state of ["draft", "in_review", "sent_back"] as const) {
      expect(items(state, "draft")).toContain("delete");
      expect(items(state, "draft")).not.toContain("unpublish");
    }
  });

  it("audit r1 N2: a taken-down book has no Delete (deleteBook refuses it)", () => {
    expect(items("taken_down", "draft")).not.toContain("delete");
    expect(items("taken_down", "draft")).not.toContain("unpublish");
  });

  it("a book waiting for review has no edit or series items", () => {
    for (const [state, status] of [["in_review", "draft"], ["live_in_review", "published"]] as const) {
      const list = items(state, status);
      for (const item of ["edit_details", "edit_content", "edit_price", "series"] as const) expect(list).not.toContain(item);
    }
  });

  it("discard only with waiting changes; download only with a file", () => {
    expect(items("live_changes", "published")).toContain("discard_changes");
    expect(items("live_sent_back", "published")).toContain("discard_changes");
    expect(items("live", "published")).not.toContain("discard_changes");
    expect(items("live_in_review", "published")).not.toContain("discard_changes");
    expect(items("draft", "draft", false)).not.toContain("download_file");
    expect(items("draft", "draft", true)).toContain("download_file");
  });

  it("view page vs preview: never twice, never the main button again", () => {
    expect(items("live", "published")).not.toContain("view_page");
    expect(items("live_changes", "published")).toContain("view_page");
    expect(items("draft", "draft")).toContain("preview_page");
    expect(items("live", "published")).not.toContain("preview_page");
  });
});

describe("parseShelfQuery / shelfHref", () => {
  it("defaults, known values, unknown values and the search", () => {
    expect(parseShelfQuery({})).toEqual({ sort: "new", filter: "all", view: "series", q: "" });
    expect(parseShelfQuery({ sort: "az", filter: "changes", view: "flat", q: "  Dimri " })).toEqual({
      sort: "az",
      filter: "changes",
      view: "flat",
      q: "Dimri",
    });
    expect(parseShelfQuery({ sort: "updated", filter: "toString", view: "x" })).toEqual({
      sort: "new",
      filter: "all",
      view: "series",
      q: "",
    });
    expect(parseShelfQuery({ q: "a".repeat(500) }).q).toHaveLength(200);
  });

  it("Q2 a: no 'last changed' sort exists", () => {
    expect(parseShelfQuery({ sort: "mod" }).sort).toBe("new");
  });

  it("builds a /dashboard link with only the non-default values", () => {
    expect(shelfHref(parseShelfQuery({}))).toBe("/dashboard");
    expect(shelfHref(parseShelfQuery({ filter: "draft", q: "a b" }))).toBe("/dashboard?filter=draft&q=a+b");
  });
});

describe("matchesShelfFilter", () => {
  it("every state is reachable from at least one filter other than all", () => {
    for (const state of ALL_STATES) {
      expect(SHELF_FILTERS.some((f) => f.value !== "all" && matchesShelfFilter(state, f.value))).toBe(true);
    }
  });

  it("Publikuar covers every live state; Në shqyrtim both review states", () => {
    expect(ALL_STATES.filter((s) => matchesShelfFilter(s, "live")).sort()).toEqual(
      ["live", "live_changes", "live_in_review", "live_sent_back"].sort(),
    );
    expect(ALL_STATES.filter((s) => matchesShelfFilter(s, "review")).sort()).toEqual(["in_review", "live_in_review"]);
    expect(ALL_STATES.every((s) => matchesShelfFilter(s, "all"))).toBe(true);
  });
});

const book = (id: string, extra: Partial<ShelfBook> = {}): ShelfBook => ({
  id,
  title: id,
  status: "draft",
  created_at: "2026-10-01T00:00:00Z",
  published_at: null,
  series_id: null,
  series_position: null,
  ...extra,
});

describe("sortShelfBooks", () => {
  const books = [
    book("b", { title: "Çerdhja", created_at: "2026-10-02T00:00:00Z", published_at: "2026-10-03T00:00:00Z" }),
    book("a", { title: "Zogu", created_at: "2026-10-03T00:00:00Z" }),
    book("c", { title: "Cana", created_at: "2026-10-01T00:00:00Z", published_at: "2026-10-05T00:00:00Z" }),
  ];
  const ids = (list: ShelfBook[]) => list.map((b) => b.id);

  it("newest created first", () => {
    expect(ids(sortShelfBooks(books, "new"))).toEqual(["a", "b", "c"]);
  });

  it("title A–Z in Albanian order (C before Ç)", () => {
    expect(ids(sortShelfBooks(books, "az"))).toEqual(["c", "b", "a"]);
  });

  it("publish date newest first, never-published last", () => {
    expect(ids(sortShelfBooks(books, "pub"))).toEqual(["c", "b", "a"]);
  });

  it("does not change the input", () => {
    const copy = [...books];
    sortShelfBooks(books, "az");
    expect(books).toEqual(copy);
  });
});

describe("groupShelfBooks", () => {
  const titles = new Map([["s1", "Kronikat"]]);

  it("series first in reading order, then the loose books; unknown series go loose", () => {
    const sorted = [
      book("x"),
      book("two", { series_id: "s1", series_position: 2 }),
      book("one", { series_id: "s1", series_position: 1 }),
      book("ghost", { series_id: "s9", series_position: 1 }),
      book("nopos", { series_id: "s1" }),
    ];
    const groups = groupShelfBooks(sorted, "series", titles);
    expect(groups.map((g) => [g.seriesTitle, g.books.map((b) => b.id)])).toEqual([
      ["Kronikat", ["one", "two", "nopos"]],
      [null, ["x", "ghost"]],
    ]);
  });

  it("flat: one group in the sort's order; empty: no groups", () => {
    const sorted = [book("two", { series_id: "s1", series_position: 2 }), book("one", { series_id: "s1", series_position: 1 })];
    expect(groupShelfBooks(sorted, "flat", titles)).toEqual([{ seriesId: null, seriesTitle: null, books: sorted }]);
    expect(groupShelfBooks([], "flat", titles)).toEqual([]);
    expect(groupShelfBooks([], "series", titles)).toEqual([]);
  });
});
