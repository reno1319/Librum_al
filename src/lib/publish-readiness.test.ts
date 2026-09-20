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
  it("free book, paid publishing unavailable: not blocked", () => {
    const result = resolvePublishReadiness({
      book: book({ price_cents: 0 }),
      paidPublishingAvailable: false,
    });
    expect(result.paidPublishingBlocked).toBe(false);
  });

  it("paid book, paid publishing unavailable: blocked", () => {
    const result = resolvePublishReadiness({
      book: book({ price_cents: 999 }),
      paidPublishingAvailable: false,
    });
    expect(result.paidPublishingBlocked).toBe(true);
  });

  it("paid book, paid publishing available: not blocked", () => {
    const result = resolvePublishReadiness({
      book: book({ price_cents: 999 }),
      paidPublishingAvailable: true,
    });
    expect(result.paidPublishingBlocked).toBe(false);
  });

  // PR-G: requiredMet was removed rather than renamed -- it had no
  // production consumer and was exactly !paidPublishingBlocked. This
  // asserts the field is actually gone from the returned object, not
  // merely unused, so a later edit cannot quietly reintroduce a second
  // source of truth for the same question.
  it("returns exactly paidPublishingBlocked and recommended -- no requiredMet", () => {
    const result = resolvePublishReadiness({ book: book(), paidPublishingAvailable: true });
    expect(Object.keys(result).sort()).toEqual(["paidPublishingBlocked", "recommended"]);
    expect("requiredMet" in result).toBe(false);
  });

  // PR-G: the readiness model is provider-neutral now. No field, and no
  // input, may carry a payment-provider or payout name.
  it("exposes no payout- or Stripe-named field", () => {
    const result = resolvePublishReadiness({ book: book(), paidPublishingAvailable: true });
    for (const key of Object.keys(result)) {
      expect(key.toLowerCase()).not.toContain("payout");
      expect(key.toLowerCase()).not.toContain("stripe");
    }
  });

  it("recommended items reflect description/keywords completeness", () => {
    const result = resolvePublishReadiness({
      book: book({ description: "a".repeat(60), keywords: "sci-fi" }),
      paidPublishingAvailable: true,
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
    const result = resolvePublishReadiness({ book: book(), paidPublishingAvailable: true });
    const labels = result.recommended.map((item) => item.label.toLowerCase());
    expect(labels.some((label) => label.includes("look inside"))).toBe(false);
    expect(labels.some((label) => label.includes("preview"))).toBe(false);
  });

  it("advisory items never affect paidPublishingBlocked, whether complete or not", () => {
    const incomplete = resolvePublishReadiness({
      book: book({ price_cents: 0 }),
      paidPublishingAvailable: false,
    });
    const complete = resolvePublishReadiness({
      book: book({
        price_cents: 0,
        description: "a".repeat(60),
        keywords: "x",
      }),
      paidPublishingAvailable: false,
    });
    expect(incomplete.paidPublishingBlocked).toBe(false);
    expect(complete.paidPublishingBlocked).toBe(false);
  });

  it("excludes cover and price checklist items from the recommended list", () => {
    const result = resolvePublishReadiness({ book: book(), paidPublishingAvailable: true });
    const labels = result.recommended.map((item) => item.label.toLowerCase());
    expect(labels.some((label) => label.includes("cover"))).toBe(false);
    expect(labels.some((label) => label.includes("price"))).toBe(false);
  });
});
