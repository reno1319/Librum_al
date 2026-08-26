import { describe, expect, it } from "vitest";
import { resolvePublishReadiness } from "./publish-readiness";

const book = (overrides: Partial<Parameters<typeof resolvePublishReadiness>[0]["book"]> = {}) => ({
  description: "",
  keywords: "",
  preview_text: "",
  price_cents: 0,
  cover_path: "some/path.jpg",
  ...overrides,
});

describe("resolvePublishReadiness", () => {
  it("free book, payouts disabled: required gate met", () => {
    const result = resolvePublishReadiness({ book: book({ price_cents: 0 }), payoutsEnabled: false });
    expect(result.requiredMet).toBe(true);
    expect(result.payoutBlocked).toBe(false);
  });

  it("paid book, payouts disabled: required gate NOT met", () => {
    const result = resolvePublishReadiness({ book: book({ price_cents: 999 }), payoutsEnabled: false });
    expect(result.requiredMet).toBe(false);
    expect(result.payoutBlocked).toBe(true);
  });

  it("paid book, payouts enabled: required gate met", () => {
    const result = resolvePublishReadiness({ book: book({ price_cents: 999 }), payoutsEnabled: true });
    expect(result.requiredMet).toBe(true);
    expect(result.payoutBlocked).toBe(false);
  });

  it("recommended items reflect description/keywords/preview completeness", () => {
    const result = resolvePublishReadiness({
      book: book({ description: "a".repeat(60), keywords: "sci-fi", preview_text: "" }),
      payoutsEnabled: true,
    });
    expect(result.recommended).toHaveLength(3);
    const doneCount = result.recommended.filter((item) => item.done).length;
    expect(doneCount).toBe(2);
  });

  it("advisory items never affect requiredMet, whether complete or not", () => {
    const incomplete = resolvePublishReadiness({ book: book({ price_cents: 0 }), payoutsEnabled: false });
    const complete = resolvePublishReadiness({
      book: book({
        price_cents: 0,
        description: "a".repeat(60),
        keywords: "x",
        preview_text: "y",
      }),
      payoutsEnabled: false,
    });
    expect(incomplete.requiredMet).toBe(true);
    expect(complete.requiredMet).toBe(true);
  });

  it("excludes cover and price checklist items from the recommended list", () => {
    const result = resolvePublishReadiness({ book: book(), payoutsEnabled: true });
    const labels = result.recommended.map((item) => item.label.toLowerCase());
    expect(labels.some((label) => label.includes("cover"))).toBe(false);
    expect(labels.some((label) => label.includes("price"))).toBe(false);
  });
});
