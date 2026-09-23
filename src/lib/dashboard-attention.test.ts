import { describe, expect, it } from "vitest";
import { resolveDashboardAttention } from "./dashboard-attention";

const book = (overrides: Partial<Parameters<typeof resolveDashboardAttention>[0]["books"][number]>) => ({
  id: "book-1",
  title: "Untitled",
  status: "draft" as const,
  price_all: 199,
  created_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("resolveDashboardAttention", () => {
  it("zero books beats everything, even unavailable paid publishing", () => {
    expect(
      resolveDashboardAttention({ books: [], paidPublishingAvailable: false }),
    ).toEqual({ kind: "zero-books" });
  });

  // PR-G: this is the assertion that REVERSED. The paid-publishing slot
  // used to outrank continue-draft, which permanently suppressed the
  // draft prompt for every author with a priced book (nothing they could
  // do ever cleared the higher slot). An actionable prompt now wins.
  it("an actionable draft beats paid publishing being unavailable", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "draft", price_all: 500 })],
      paidPublishingAvailable: false,
    });
    expect(result).toEqual({ kind: "continue-draft", book: { id: "b1", title: "Untitled" } });
  });

  it("paid publishing being unavailable is reported when no draft action exists", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "published", price_all: 500 })],
      paidPublishingAvailable: false,
    });
    expect(result).toEqual({ kind: "paid-publishing-unavailable" });
  });

  // The draft prompt is not permanently suppressed: an author with both a
  // draft and a published priced book is told about the draft, and once
  // the draft is dealt with the paid-publishing notice is still reachable.
  it("the draft prompt is never permanently suppressed by unavailable paid publishing", () => {
    const withDraft = resolveDashboardAttention({
      books: [
        book({ id: "published", status: "published", price_all: 500 }),
        book({ id: "draft", status: "draft", price_all: 500 }),
      ],
      paidPublishingAvailable: false,
    });
    expect(withDraft).toEqual({ kind: "continue-draft", book: { id: "draft", title: "Untitled" } });

    const draftResolved = resolveDashboardAttention({
      books: [
        book({ id: "published", status: "published", price_all: 500 }),
        book({ id: "draft", status: "published", price_all: 500 }),
      ],
      paidPublishingAvailable: false,
    });
    expect(draftResolved).toEqual({ kind: "paid-publishing-unavailable" });
  });

  it("draft when paid publishing is available", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "draft", price_all: 500 })],
      paidPublishingAvailable: true,
    });
    expect(result).toEqual({ kind: "continue-draft", book: { id: "b1", title: "Untitled" } });
  });

  it("draft when paid publishing is irrelevant because every book is free", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "draft", price_all: 0 })],
      paidPublishingAvailable: false,
    });
    expect(result).toEqual({ kind: "continue-draft", book: { id: "b1", title: "Untitled" } });
  });

  it("none when a free-book-only author has no drafts and paid publishing is unavailable", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "published", price_all: 0 })],
      paidPublishingAvailable: false,
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("none when there are books, no drafts, and paid publishing is available", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "published", price_all: 500 })],
      paidPublishingAvailable: true,
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("none when the paid-publishing gap doesn't apply and no draft exists", () => {
    const result = resolveDashboardAttention({
      books: [
        book({ id: "b1", status: "published", price_all: 0 }),
        book({ id: "b2", status: "published", price_all: 500 }),
      ],
      paidPublishingAvailable: true,
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("picks the most recently created draft when multiple drafts exist", () => {
    const result = resolveDashboardAttention({
      books: [
        book({ id: "older", title: "Older draft", status: "draft", price_all: 0, created_at: "2025-01-01T00:00:00.000Z" }),
        book({ id: "newer", title: "Newer draft", status: "draft", price_all: 0, created_at: "2026-06-01T00:00:00.000Z" }),
      ],
      paidPublishingAvailable: true,
    });
    expect(result).toEqual({ kind: "continue-draft", book: { id: "newer", title: "Newer draft" } });
  });
});

// ALL-WIRING-2: a book with NO authored ALL price is not a paid book.
// Nothing about paid publishing is what stands between it and going
// live -- it needs a price first -- so reporting
// "paid-publishing-unavailable" for it would name the wrong obstacle.
// The old `price_cents > 0` test would have reported exactly that for
// this row, since its legacy price_cents is 0 only by default.
describe("resolveDashboardAttention: unpriced books are not paid books", () => {
  it("an unpriced published book does not trigger the paid-publishing notice", () => {
    expect(
      resolveDashboardAttention({
        books: [book({ id: "b1", status: "published", price_all: null })],
        paidPublishingAvailable: false,
      }),
    ).toEqual({ kind: "none" });
  });

  it("a genuinely paid book still does, even beside an unpriced one", () => {
    expect(
      resolveDashboardAttention({
        books: [
          book({ id: "b1", status: "published", price_all: null }),
          book({ id: "b2", status: "published", price_all: 199 }),
        ],
        paidPublishingAvailable: false,
      }),
    ).toEqual({ kind: "paid-publishing-unavailable" });
  });
});
