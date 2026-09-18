import { describe, expect, it } from "vitest";
import { resolvePublishReadiness } from "./publish-readiness";

const book = (overrides: Partial<Parameters<typeof resolvePublishReadiness>[0]["book"]> = {}) => ({
  description: "",
  keywords: "",
  price_cents: 0,
  cover_path: "some/path.jpg",
  ...overrides,
});

// ALL-CUTOVER / STRIPE-RETIREMENT: `payoutBlocked` and the
// `payoutsEnabled` input are gone -- they mirrored performPublish()'s
// Stripe Connect gate, and that gate has been removed. requiredMet
// stays, and is now always true; these cases pin that nothing about a
// book's price can make it false, which is the whole behavioural
// change.
describe("resolvePublishReadiness", () => {
  it("free book: required gate met", () => {
    expect(resolvePublishReadiness({ book: book({ price_cents: 0 }) }).requiredMet).toBe(true);
  });

  it("paid book: required gate met -- price no longer blocks publishing", () => {
    expect(resolvePublishReadiness({ book: book({ price_cents: 9900 }) }).requiredMet).toBe(true);
  });

  it("the most expensive book the catalog allows is still not blocked", () => {
    expect(
      resolvePublishReadiness({ book: book({ price_cents: 10000000 }) }).requiredMet,
    ).toBe(true);
  });

  it("recommended items reflect description/keywords completeness", () => {
    const result = resolvePublishReadiness({
      book: book({ description: "a".repeat(60), keywords: "sci-fi" }),
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
    const result = resolvePublishReadiness({ book: book() });
    const labels = result.recommended.map((item) => item.label.toLowerCase());
    expect(labels.some((label) => label.includes("look inside"))).toBe(false);
    expect(labels.some((label) => label.includes("preview"))).toBe(false);
  });

  it("advisory items never affect requiredMet, whether complete or not", () => {
    const incomplete = resolvePublishReadiness({ book: book({ price_cents: 0 }) });
    const complete = resolvePublishReadiness({
      book: book({
        price_cents: 0,
        description: "a".repeat(60),
        keywords: "x",
      }),
    });
    expect(incomplete.requiredMet).toBe(true);
    expect(complete.requiredMet).toBe(true);
  });

  it("excludes cover and price checklist items from the recommended list", () => {
    const result = resolvePublishReadiness({ book: book() });
    const labels = result.recommended.map((item) => item.label.toLowerCase());
    expect(labels.some((label) => label.includes("cover"))).toBe(false);
    expect(labels.some((label) => label.includes("price"))).toBe(false);
  });
});
