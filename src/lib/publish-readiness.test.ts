import { describe, expect, it, vi } from "vitest";
import { checkPublishGate, resolvePublishReadiness } from "./publish-readiness";

const book = (overrides: Partial<Parameters<typeof resolvePublishReadiness>[0]["book"]> = {}) => ({
  description: "",
  keywords: "",
  price_all: 0,
  cover_path: "some/path.jpg",
  ...overrides,
});

describe("resolvePublishReadiness", () => {
  it("free book, paid publishing unavailable: not blocked", () => {
    const result = resolvePublishReadiness({
      book: book({ price_all: 0 }),
      paidPublishingAvailable: false,
      hasRightsDeclaration: true,
    });
    expect(result.paidPublishingBlocked).toBe(false);
  });

  it("paid book, paid publishing unavailable: blocked", () => {
    const result = resolvePublishReadiness({
      book: book({ price_all: 199 }),
      paidPublishingAvailable: false,
      hasRightsDeclaration: true,
    });
    expect(result.paidPublishingBlocked).toBe(true);
  });

  it("paid book, paid publishing available: not blocked", () => {
    const result = resolvePublishReadiness({
      book: book({ price_all: 199 }),
      paidPublishingAvailable: true,
      hasRightsDeclaration: true,
    });
    expect(result.paidPublishingBlocked).toBe(false);
  });

  // PR-G: requiredMet was removed rather than renamed -- it had no
  // production consumer and was exactly !paidPublishingBlocked. This
  // asserts the field is actually gone from the returned object, not
  // merely unused, so a later edit cannot quietly reintroduce a second
  // source of truth for the same question.
  it("returns exactly missingAllPrice, missingDescription, missingRights, paidPublishingBlocked and recommended -- no requiredMet", () => {
    const result = resolvePublishReadiness({ book: book(), paidPublishingAvailable: true, hasRightsDeclaration: true });
    expect(Object.keys(result).sort()).toEqual([
      "missingAllPrice",
      "missingDescription",
      "missingRights",
      "paidPublishingBlocked",
      "recommended",
    ]);
    expect("requiredMet" in result).toBe(false);
  });

  // PR-G: the readiness model is provider-neutral now. No field, and no
  // input, may carry a payment-provider or payout name.
  it("exposes no payout- or Stripe-named field", () => {
    const result = resolvePublishReadiness({ book: book(), paidPublishingAvailable: true, hasRightsDeclaration: true });
    for (const key of Object.keys(result)) {
      expect(key.toLowerCase()).not.toContain("payout");
      expect(key.toLowerCase()).not.toContain("stripe");
    }
  });

  it("recommended items reflect description/keywords completeness", () => {
    const result = resolvePublishReadiness({
      book: book({ description: "a".repeat(60), keywords: "sci-fi" }),
      paidPublishingAvailable: true,
      hasRightsDeclaration: true,
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
    const result = resolvePublishReadiness({ book: book(), paidPublishingAvailable: true, hasRightsDeclaration: true });
    const labels = result.recommended.map((item) => item.label.toLowerCase());
    expect(labels.some((label) => label.includes("look inside"))).toBe(false);
    expect(labels.some((label) => label.includes("preview"))).toBe(false);
  });

  it("advisory items never affect paidPublishingBlocked, whether complete or not", () => {
    const incomplete = resolvePublishReadiness({
      book: book({ price_all: 0 }),
      paidPublishingAvailable: false,
      hasRightsDeclaration: true,
    });
    const complete = resolvePublishReadiness({
      book: book({
        price_all: 0,
        description: "a".repeat(60),
        keywords: "x",
      }),
      paidPublishingAvailable: false,
      hasRightsDeclaration: true,
    });
    expect(incomplete.paidPublishingBlocked).toBe(false);
    expect(complete.paidPublishingBlocked).toBe(false);
  });

  it("excludes cover and price checklist items from the recommended list", () => {
    const result = resolvePublishReadiness({ book: book(), paidPublishingAvailable: true, hasRightsDeclaration: true });
    const labels = result.recommended.map((item) => item.label.toLowerCase());
    expect(labels.some((label) => label.includes("cover"))).toBe(false);
    expect(labels.some((label) => label.includes("price"))).toBe(false);
  });
});

// ALL-WIRING-2: the missing-ALL-price blocker. It is reported on its
// own, never together with paidPublishingBlocked, because an author
// cannot be simultaneously blocked by something they can fix in one
// edit and by something only Librum can change.
describe("resolvePublishReadiness: the missing-ALL-price blocker", () => {
  it("null price_all is blocked, whether or not paid publishing is available", () => {
    for (const paidPublishingAvailable of [true, false]) {
      const result = resolvePublishReadiness({
        book: book({ price_all: null }),
        paidPublishingAvailable,
        hasRightsDeclaration: true,
      });
      expect(result.missingAllPrice).toBe(true);
      // Never BOTH: naming two obstacles for one refusal is the failure
      // mode this separation exists to prevent.
      expect(result.paidPublishingBlocked).toBe(false);
    }
  });

  it("a free book is never reported as missing a price", () => {
    const result = resolvePublishReadiness({
      book: book({ price_all: 0 }),
      paidPublishingAvailable: false,
      hasRightsDeclaration: true,
    });
    expect(result.missingAllPrice).toBe(false);
    expect(result.paidPublishingBlocked).toBe(false);
  });

  it("a paid book is never reported as missing a price", () => {
    const result = resolvePublishReadiness({
      book: book({ price_all: 199 }),
      paidPublishingAvailable: false,
      hasRightsDeclaration: true,
    });
    expect(result.missingAllPrice).toBe(false);
    expect(result.paidPublishingBlocked).toBe(true);
  });

  // FIX1 (X16): a description is required before Publish.
  it("an empty or whitespace-only description is a blocker, not a recommendation", () => {
    for (const description of ["", "   \n "]) {
      const result = resolvePublishReadiness({
        book: book({ description }),
        paidPublishingAvailable: true,
        hasRightsDeclaration: true,
      });
      expect(result.missingDescription).toBe(true);
      expect(result.recommended.map((item) => item.label)).not.toContain(
        "Write a description (a couple of sentences or more)",
      );
    }
  });

  it("a short description clears the blocker and keeps the longer-description recommendation", () => {
    const result = resolvePublishReadiness({
      book: book({ description: "Poems." }),
      paidPublishingAvailable: true,
      hasRightsDeclaration: true,
    });
    expect(result.missingDescription).toBe(false);
    expect(result.recommended).toContainEqual({
      label: "Write a description (a couple of sentences or more)",
      done: false,
    });
  });
});

describe("resolvePublishReadiness: the rights choice (F4, P4)", () => {
  it("a book without a rights declaration reports missingRights", () => {
    const result = resolvePublishReadiness({
      book: book({ description: "A real description." }),
      paidPublishingAvailable: true,
      hasRightsDeclaration: false,
    });
    expect(result.missingRights).toBe(true);
  });

  it("a book with a declaration does not", () => {
    const result = resolvePublishReadiness({
      book: book({ description: "A real description." }),
      paidPublishingAvailable: true,
      hasRightsDeclaration: true,
    });
    expect(result.missingRights).toBe(false);
  });

  it("is independent of the other blockers (each is its own flag)", () => {
    const result = resolvePublishReadiness({
      book: book({ description: "", price_all: null }),
      paidPublishingAvailable: false,
      hasRightsDeclaration: false,
    });
    expect(result).toMatchObject({ missingAllPrice: true, missingDescription: true, missingRights: true });
  });
});

// ADMIN-3-REVIEW (M2): the shared publish gate, used by performPublish
// and the staff Approve action -- four checks in one order, and no read
// after an earlier refusal.
describe("checkPublishGate", () => {
  const gate = (overrides: Partial<Parameters<typeof checkPublishGate>[0]> = {}) => {
    const readRights = vi.fn(async () => "present" as const);
    const paid = vi.fn(() => true);
    return {
      readRights,
      paid,
      run: () =>
        checkPublishGate({ priceAll: 0, description: "A description.", readRights, paidPublishingAvailable: paid, ...overrides }),
    };
  };

  it("a free book with a description and rights passes, without asking about paid publishing", async () => {
    const g = gate();
    expect(await g.run()).toEqual({ ok: true });
    expect(g.paid).not.toHaveBeenCalled();
  });

  it("refuses a missing price first, before any read", async () => {
    const g = gate({ priceAll: null, description: "" });
    expect(await g.run()).toEqual({ ok: false, reason: "missing_all_price" });
    expect(g.readRights).not.toHaveBeenCalled();
  });

  it("then a blank description, before the rights read", async () => {
    for (const description of ["", "   \n", null]) {
      const g = gate({ description });
      expect(await g.run()).toEqual({ ok: false, reason: "missing_description" });
      expect(g.readRights).not.toHaveBeenCalled();
    }
  });

  it("then the rights choice: none, or unreadable", async () => {
    expect(await gate({ readRights: async () => "none" }).run()).toEqual({ ok: false, reason: "missing_rights" });
    expect(await gate({ readRights: async () => "unavailable" }).run()).toEqual({ ok: false, reason: "rights_unavailable" });
  });

  it("then, for a paid title only, paid publishing", async () => {
    expect(await gate({ priceAll: 990, paidPublishingAvailable: () => false }).run()).toEqual({
      ok: false,
      reason: "paid_mode_required",
    });
    expect(await gate({ priceAll: 990, paidPublishingAvailable: () => true }).run()).toEqual({ ok: true });
  });
});
