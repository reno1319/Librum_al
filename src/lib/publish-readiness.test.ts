import { describe, expect, it } from "vitest";
import { resolvePublishReadiness } from "./publish-readiness";

const book = (overrides: Partial<Parameters<typeof resolvePublishReadiness>[0]["book"]> = {}) => ({
  description: "",
  keywords: "",
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

  it("recommended items reflect description/keywords completeness", () => {
    const result = resolvePublishReadiness({
      book: book({ description: "a".repeat(60), keywords: "sci-fi" }),
      payoutsEnabled: true,
    });
    expect(result.recommended).toHaveLength(2);
    const doneCount = result.recommended.filter((item) => item.done).length;
    expect(doneCount).toBe(2);
  });

  // LIBRUM 2.0 PRODUCT-1 PRE-COMMIT CORRECTION: preview_text is no
  // longer part of this function's input or output at all -- its only
  // former purpose (the "Look inside" recommended item) was removed,
  // not relabeled, once Read Sample replaced that public presentation.
  it("never recommends a preview-excerpt item -- that surface no longer exists", () => {
    const result = resolvePublishReadiness({ book: book(), payoutsEnabled: true });
    const labels = result.recommended.map((item) => item.label.toLowerCase());
    expect(labels.some((label) => label.includes("look inside"))).toBe(false);
    expect(labels.some((label) => label.includes("preview"))).toBe(false);
  });

  it("advisory items never affect requiredMet, whether complete or not", () => {
    const incomplete = resolvePublishReadiness({ book: book({ price_cents: 0 }), payoutsEnabled: false });
    const complete = resolvePublishReadiness({
      book: book({
        price_cents: 0,
        description: "a".repeat(60),
        keywords: "x",
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
