import { describe, expect, it } from "vitest";
import {
  ALLOWED_AGAIN_SUCCESS_MESSAGE,
  BOOKS_FILTERS,
  CHOOSE_REASON_MESSAGE,
  GENERIC_TAKEDOWN_ERROR_MESSAGE,
  MESSAGE_TOO_LONG_MESSAGE,
  WRITE_MESSAGE_MESSAGE,
  bookStateLabel,
  booksListHref,
  booksSearchPattern,
  buildBooksSearchOrFilter,
  describeBookEyebrow,
  isUuid,
  mapTakedownRpcError,
  parseBooksFilter,
  parseBooksPage,
  parseBooksSearch,
  quotePostgrestValue,
  resolveTakedownReport,
  validateUnpublishForm,
} from "./book-admin-logic";

// ADMIN-2-TAKEDOWN: the pure decisions behind /admin/books and
// /admin/books/[id].
const PEN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTHOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REPORT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

describe("books list filters (B)", () => {
  it("offers All, Live, Draft and Taken down", () => {
    expect(BOOKS_FILTERS.map((f) => f.label)).toEqual(["All", "Live", "Draft", "Taken down"]);
  });

  it("reads a known filter and falls back to All", () => {
    expect(parseBooksFilter("live")).toBe("live");
    expect(parseBooksFilter("draft")).toBe("draft");
    expect(parseBooksFilter(["taken_down", "live"])).toBe("taken_down");
    expect(parseBooksFilter("published")).toBe("all");
    expect(parseBooksFilter(undefined)).toBe("all");
  });

  it("reads a page number, never below 1", () => {
    expect(parseBooksPage("3")).toBe(3);
    expect(parseBooksPage("0")).toBe(1);
    expect(parseBooksPage("-2")).toBe(1);
    expect(parseBooksPage("2abc")).toBe(1);
    expect(parseBooksPage(undefined)).toBe(1);
  });

  it("trims the search and caps it at 100 characters", () => {
    expect(parseBooksSearch("  Kënga  ")).toBe("Kënga");
    expect(parseBooksSearch("x".repeat(150))).toHaveLength(100);
    expect(parseBooksSearch(42)).toBe("");
  });

  it("builds list links that keep the filter and search", () => {
    expect(booksListHref("all", "")).toBe("/admin/books");
    expect(booksListHref("live", "a&b")).toBe("/admin/books?status=live&q=a%26b");
    expect(booksListHref("draft", "", 2)).toBe("/admin/books?status=draft&page=2");
  });

  it("labels a row Live, Draft or Taken down", () => {
    expect(bookStateLabel("published", false)).toBe("Live");
    expect(bookStateLabel("draft", false)).toBe("Draft");
    expect(bookStateLabel("draft", true)).toBe("Taken down");
  });
});

describe("books search escaping (S5)", () => {
  it("makes %, _ and backslash match themselves", () => {
    expect(booksSearchPattern("50%_off\\")).toBe("%50\\%\\_off\\\\%");
  });

  it("quotes a PostgREST value, escaping backslash and double quote", () => {
    expect(quotePostgrestValue('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it("keeps filter syntax in the search as data", () => {
    const filter = buildBooksSearchOrFilter('x),author_id.eq.1,title.ilike."', [], []);
    // `_` is ILIKE-escaped (\_), then that backslash is quoted (\\_).
    expect(filter).toBe('title.ilike."%x),author\\\\_id.eq.1,title.ilike.\\"%"');
    expect(filter.split(",title.ilike.").length).toBe(2);
  });

  it("adds the matching pen names and authors, dropping anything that is not a uuid", () => {
    expect(buildBooksSearchOrFilter("ana", [PEN, "not-a-uuid"], [AUTHOR, "1),x"])).toBe(
      `title.ilike."%ana%",pen_name_id.in.(${PEN}),author_id.in.(${AUTHOR})`,
    );
  });
});

describe("the book page eyebrow (C)", () => {
  it("shows the live price, free, draft and taken down", () => {
    expect(describeBookEyebrow({ status: "published", price_all: 499 }, false)).toBe("Live · Paid · 499 ALL");
    expect(describeBookEyebrow({ status: "published", price_all: 0 }, false)).toBe("Live · Free");
    expect(describeBookEyebrow({ status: "draft", price_all: 499 }, false)).toBe("Draft");
    expect(describeBookEyebrow({ status: "draft", price_all: 0 }, true)).toBe("Taken down");
  });

  it("never invents a price it can't read", () => {
    expect(describeBookEyebrow({ status: "published", price_all: null }, false)).toBe("Live · Price unavailable");
  });
});

describe("?report= (D)", () => {
  const open = [{ id: REPORT }];

  it("counts only an open report of this book", () => {
    expect(resolveTakedownReport(REPORT, open)).toEqual({ id: REPORT });
    expect(resolveTakedownReport(REPORT.toUpperCase(), open)).toEqual({ id: REPORT });
    expect(resolveTakedownReport(PEN, open)).toBeNull();
    expect(resolveTakedownReport("not-a-uuid", open)).toBeNull();
    expect(resolveTakedownReport(undefined, open)).toBeNull();
  });
});

describe("validateUnpublishForm", () => {
  function form(fields: Record<string, string>): FormData {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return data;
  }

  it("accepts a reason and a message, trimmed, with an optional report", () => {
    expect(validateUnpublishForm(form({ reason: "copyright", message: "  Proof, please.  ", reportId: REPORT }))).toEqual(
      { ok: true, reason: "copyright", message: "Proof, please.", reportId: REPORT },
    );
    expect(validateUnpublishForm(form({ reason: "other", message: "Why", reportId: "x" }))).toEqual({
      ok: true,
      reason: "other",
      message: "Why",
      reportId: null,
    });
  });

  it("refuses an unknown reason, an empty message and an over-long one", () => {
    expect(validateUnpublishForm(form({ reason: "spam", message: "x" }))).toEqual({ ok: false, error: CHOOSE_REASON_MESSAGE });
    expect(validateUnpublishForm(form({ reason: "other", message: "   " }))).toEqual({ ok: false, error: WRITE_MESSAGE_MESSAGE });
    expect(validateUnpublishForm(form({ reason: "other", message: "x".repeat(2001) }))).toEqual({
      ok: false,
      error: MESSAGE_TOO_LONG_MESSAGE,
    });
    expect(validateUnpublishForm(form({ reason: "other", message: "x".repeat(2000) })).ok).toBe(true);
  });
});

describe("mapTakedownRpcError", () => {
  it("maps a deadlock to a retry", () => {
    expect(mapTakedownRpcError({ code: "40P01", message: "deadlock detected" })).toBe("Please try again.");
  });

  it("maps the RPC's own messages to plain words", () => {
    expect(mapTakedownRpcError({ message: "this book is already taken down" })).toBe("This book is already taken down.");
    expect(mapTakedownRpcError({ message: "not authorized" })).toBe("You don't have permission to unpublish books.");
    expect(mapTakedownRpcError({ message: "no open report for this book" })).toMatch(/no longer open/);
    expect(mapTakedownRpcError({ message: "this book is not taken down" })).toBe("This book is not taken down.");
  });

  it("never shows raw database text", () => {
    expect(mapTakedownRpcError({ code: "42501", message: "permission denied for table books" })).toBe(
      GENERIC_TAKEDOWN_ERROR_MESSAGE,
    );
    expect(mapTakedownRpcError(null)).toBe(GENERIC_TAKEDOWN_ERROR_MESSAGE);
  });
});

it("isUuid", () => {
  expect(isUuid(REPORT)).toBe(true);
  expect(isUuid("x")).toBe(false);
  expect(isUuid(null)).toBe(false);
  expect(ALLOWED_AGAIN_SUCCESS_MESSAGE).toBe("The author can publish this book again.");
});
