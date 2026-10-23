import { describe, expect, it } from "vitest";
import {
  PEOPLE_SEARCH_MAX_LENGTH,
  parsePeopleKind,
  parsePeoplePage,
  parsePeopleSearch,
  peopleCountLabel,
  peopleListHref,
  personBankLabel,
  personBooksLabel,
  personSalesLabel,
  personStatusLabel,
  personTypeLabel,
} from "./people-logic";

describe("People list parameters", () => {
  it("accepts the four kinds and falls back to everyone", () => {
    expect(parsePeopleKind("authors")).toBe("authors");
    expect(parsePeopleKind("readers")).toBe("readers");
    expect(parsePeopleKind("suspended")).toBe("suspended");
    expect(parsePeopleKind(["suspended", "authors"])).toBe("suspended");
    expect(parsePeopleKind("staff")).toBe("everyone");
    expect(parsePeopleKind(undefined)).toBe("everyone");
  });

  it("trims the search and caps it at the RPC's limit", () => {
    expect(parsePeopleSearch("  hoxha ")).toBe("hoxha");
    expect(parsePeopleSearch(undefined)).toBe("");
    expect(parsePeopleSearch(["a", "b"])).toBe("a");
    expect(parsePeopleSearch("x".repeat(PEOPLE_SEARCH_MAX_LENGTH + 50))).toHaveLength(PEOPLE_SEARCH_MAX_LENGTH);
  });

  it("reads a page number, 1 for anything else", () => {
    expect(parsePeoplePage("3")).toBe(3);
    expect(parsePeoplePage("0")).toBe(1);
    expect(parsePeoplePage("-2")).toBe(1);
    expect(parsePeoplePage("2.5")).toBe(1);
    expect(parsePeoplePage(undefined)).toBe(1);
  });

  it("builds the list link with only the parameters that differ from the default", () => {
    expect(peopleListHref("everyone", "")).toBe("/admin/people");
    expect(peopleListHref("authors", "")).toBe("/admin/people?show=authors");
    expect(peopleListHref("everyone", "ana & co")).toBe("/admin/people?q=ana+%26+co");
    expect(peopleListHref("suspended", "x", 2)).toBe("/admin/people?show=suspended&q=x&page=2");
  });
});

describe("People list labels", () => {
  const author = {
    account_type: "author",
    is_staff: false,
    live_books: 0,
    in_review_books: 0,
    draft_books: 0,
    paid_sales: 0,
    has_bank_account: false,
    suspended: false,
  };
  const reader = { ...author, account_type: "reader" };

  it("types: staff first, then author or reader", () => {
    expect(personTypeLabel(author)).toBe("Author");
    expect(personTypeLabel(reader)).toBe("Reader");
    expect(personTypeLabel({ ...reader, is_staff: true })).toBe("Staff");
    expect(personTypeLabel({ ...reader, account_type: "admin" })).toBe("Reader");
  });

  it("books column, as on the mockup", () => {
    expect(personBooksLabel({ ...author, live_books: 4 })).toBe("4 live");
    expect(personBooksLabel({ ...author, in_review_books: 1 })).toBe("1 in review");
    expect(personBooksLabel({ ...author, live_books: 4, in_review_books: 1, draft_books: 2 })).toBe("4 live · 1 in review");
    expect(personBooksLabel({ ...author, draft_books: 1 })).toBe("1 draft");
    expect(personBooksLabel({ ...author, draft_books: 3 })).toBe("3 drafts");
    expect(personBooksLabel(author)).toBe("0 live");
    expect(personBooksLabel(reader)).toBe("-");
  });

  it("sales and bank account: numbers for authors, '-' for readers", () => {
    expect(personSalesLabel({ ...author, paid_sales: 63 })).toBe("63");
    expect(personSalesLabel(author)).toBe("0");
    expect(personSalesLabel(reader)).toBe("-");
    expect(personBankLabel({ ...author, has_bank_account: true })).toBe("Added");
    expect(personBankLabel(author)).toBe("Not added");
    expect(personBankLabel(reader)).toBe("-");
  });

  it("status and count", () => {
    expect(personStatusLabel(author)).toBe("Active");
    expect(personStatusLabel({ ...author, suspended: true })).toBe("Suspended");
    expect(peopleCountLabel(1)).toBe("1 person");
    expect(peopleCountLabel(0)).toBe("0 people");
    expect(peopleCountLabel(12)).toBe("12 people");
  });
});
