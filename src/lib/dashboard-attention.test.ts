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

describe("resolveDashboardAttention", () => {
  it("zero books beats everything, even an unresolved payout gap", () => {
    expect(
      resolveDashboardAttention({ books: [], payoutsEnabled: false }),
    ).toEqual({ kind: "zero-books" });
  });

  it("payout setup beats a draft when a paid book exists and payouts aren't enabled", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "draft", price_cents: 500 })],
      payoutsEnabled: false,
    });
    expect(result).toEqual({ kind: "payout-setup" });
  });

  it("draft when payout setup is not urgent (payouts already enabled)", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "draft", price_cents: 500 })],
      payoutsEnabled: true,
    });
    expect(result).toEqual({ kind: "continue-draft", book: { id: "b1", title: "Untitled" } });
  });

  it("draft when payout setup is not urgent because every book is free", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "draft", price_cents: 0 })],
      payoutsEnabled: false,
    });
    expect(result).toEqual({ kind: "continue-draft", book: { id: "b1", title: "Untitled" } });
  });

  it("none when there are books, no drafts, and payouts are enabled", () => {
    const result = resolveDashboardAttention({
      books: [book({ id: "b1", status: "published", price_cents: 500 })],
      payoutsEnabled: true,
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("none when the only unpublished-payout gap doesn't apply and no draft exists", () => {
    const result = resolveDashboardAttention({
      books: [
        book({ id: "b1", status: "published", price_cents: 0 }),
        book({ id: "b2", status: "published", price_cents: 500 }),
      ],
      payoutsEnabled: true,
    });
    expect(result).toEqual({ kind: "none" });
  });

  it("picks the most recently created draft when multiple drafts exist", () => {
    const result = resolveDashboardAttention({
      books: [
        book({ id: "older", title: "Older draft", status: "draft", price_cents: 0, created_at: "2025-01-01T00:00:00.000Z" }),
        book({ id: "newer", title: "Newer draft", status: "draft", price_cents: 0, created_at: "2026-06-01T00:00:00.000Z" }),
      ],
      payoutsEnabled: true,
    });
    expect(result).toEqual({ kind: "continue-draft", book: { id: "newer", title: "Newer draft" } });
  });
});
