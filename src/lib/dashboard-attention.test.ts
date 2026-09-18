import { describe, expect, it } from "vitest";
import { resolveDashboardAttention } from "./dashboard-attention";

const book = (overrides: Partial<Parameters<typeof resolveDashboardAttention>[0]["books"][number]>) => ({
  id: "book-1",
  title: "Untitled",
  status: "draft" as const,
  price_cents: 999,
  created_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

// ALL-CUTOVER / STRIPE-RETIREMENT: the four "payout setup" cases that
// used to live here are gone with the "payout-setup" state itself --
// publishing a paid book no longer requires a Stripe Connect account,
// so there is no payout gap left for the dashboard to raise. What the
// remaining cases pin is that the priority order survived that removal
// intact: zero books beats a draft, and a draft beats nothing to do.
describe("resolveDashboardAttention", () => {
  it("zero books beats everything", () => {
    expect(resolveDashboardAttention({ books: [] })).toEqual({ kind: "zero-books" });
  });

  it("a draft is the next action, whether the book is paid", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "draft", price_cents: 500 })],
    });
    expect(result).toEqual({ kind: "continue-draft", book: { id: "b1", title: "Untitled" } });
  });

  it("a draft is the next action, whether the book is free", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "draft", price_cents: 0 })],
    });
    expect(result).toEqual({ kind: "continue-draft", book: { id: "b1", title: "Untitled" } });
  });

  // Regression for the removed gate: a priced draft by an author with no
  // payout account used to return { kind: "payout-setup" } and tell them
  // they could only publish free books. Nothing about the price may
  // divert the dashboard away from the draft any more.
  it("never returns anything but the draft for a priced book with no payout account", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "draft", price_cents: 100000 })],
    });
    expect(result.kind).toBe("continue-draft");
  });

  it("none when there are books and no drafts", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "published", price_cents: 500 })],
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("none when a mix of free and paid books is fully published", () => {
    const result = resolveDashboardAttention({
      books: [
        book({ id: "b1", status: "published", price_cents: 0 }),
        book({ id: "b2", status: "published", price_cents: 500 }),
      ],
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("picks the most recently created draft when multiple drafts exist", () => {
    const result = resolveDashboardAttention({
      books: [
        book({ id: "older", title: "Older draft", status: "draft", price_cents: 0, created_at: "2025-01-01T00:00:00.000Z" }),
        book({ id: "newer", title: "Newer draft", status: "draft", price_cents: 0, created_at: "2026-06-01T00:00:00.000Z" }),
      ],
    });
    expect(result).toEqual({ kind: "continue-draft", book: { id: "newer", title: "Newer draft" } });
  });
});
