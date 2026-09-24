import { describe, expect, it } from "vitest";
import { resolveCatalogPriceState } from "./catalog-price";
import {
  resolveBookPurchaseState,
  resolveCheckoutSecurityNote,
  resolveShowSample,
} from "./book-purchase";
import { getPublishChecklist } from "./publish-checklist";
import { resolvePublishReadiness } from "./publish-readiness";
import { resolveDashboardAttention } from "./dashboard-attention";
import { calculateAuthorEarnings } from "./earnings-calculator";
import { resolveWizardPriceSummary } from "@/app/(public)/dashboard/books/new/wizard-validation";

// ALL-WIRING-2: ONE table, walked by every free/paid decision that this
// patch was required to move atomically.
//
// The authorization for Patch 2 lists thirteen mandatory decision sites
// and forbids a tree in which any of them still reads `price_cents`.
// Ten of the thirteen are pure functions and are driven directly below.
// The remaining three are server actions with database side effects and
// are driven, with a Supabase double, in their own files:
//
//   buyBook          -> src/app/(public)/books/[id]/actions.test.ts
//   getFreeBook      -> src/app/(public)/books/[id]/actions.test.ts
//   performPublish   -> src/app/(public)/dashboard/books/publish.test.ts
//
// This file exists as a single place where the SAME two rows are put to
// every pure decision at once, because the failure this patch guards
// against is not "one function is wrong" -- it is "twelve moved and one
// did not". A per-module test cannot see that; a table that names all
// thirteen can.
//
// THE TWO ROWS:
//
//   LEGACY_PAID   price_all 199, price_cents 0. Real in this catalog.
//                 Under the OLD rule it is FREE at every site. It must
//                 now be PAID at every site.
//   UNPRICED      price_all null, price_cents 2500. Also real. It has
//                 no ALL price, so it is neither free nor paid, and no
//                 site may fall back to the 2500.
//
// The `price_cents` field is carried on each fixture DELIBERATELY. None
// of these functions declares it, so its presence is inert -- and that
// is the point: if any of them started reading it, these tests would
// go red rather than silently agreeing.

// One explicit shape for all three fixtures, so `price_all` is
// `number | null` everywhere rather than being narrowed to `null` on
// the unpriced row and to `number` on the other two.
type Row = {
  id: string;
  title: string;
  status: "published" | "draft";
  price_all: number | null;
  price_cents: number;
  description: string;
  keywords: string;
  cover_path: string;
  created_at: string;
};

const LEGACY_PAID: Row = {
  id: "legacy-paid",
  title: "A 199-lek book whose legacy column says zero",
  status: "published" as const,
  price_all: 199,
  price_cents: 0,
  description: "A description long enough to satisfy the checklist item it is measured against.",
  keywords: "one, two",
  cover_path: "covers/legacy-paid.png",
  created_at: "2026-01-01T00:00:00.000Z",
};

const UNPRICED: Row = {
  id: "unpriced",
  title: "A book with no authored ALL price",
  status: "published" as const,
  price_all: null,
  price_cents: 2500,
  description: "A description long enough to satisfy the checklist item it is measured against.",
  keywords: "one, two",
  cover_path: "covers/unpriced.png",
  created_at: "2026-01-02T00:00:00.000Z",
};

const FREE: Row = { ...LEGACY_PAID, id: "free", price_all: 0, price_cents: 9900 };

describe("decision site 1 of 13: the shared catalog classification", () => {
  it("199 beside a legacy 0 is paid; null beside a legacy 2500 is unavailable", () => {
    expect(resolveCatalogPriceState(LEGACY_PAID.price_all)).toBe("paid");
    expect(resolveCatalogPriceState(UNPRICED.price_all)).toBe("unavailable");
    expect(resolveCatalogPriceState(FREE.price_all)).toBe("free");
  });
});

describe("decision sites 2-3 of 13: resolveBookPurchaseState, anonymous and authenticated", () => {
  it("anonymous: paid, unavailable, free -- three distinct states", () => {
    const anon = (priceAll: number | null) =>
      resolveBookPurchaseState({ user: null, isAuthor: false, owned: false, priceAll, paidCheckoutAvailable: true });
    expect(anon(LEGACY_PAID.price_all)).toBe("anonymous-paid");
    expect(anon(UNPRICED.price_all)).toBe("anonymous-unavailable");
    expect(anon(FREE.price_all)).toBe("anonymous-free");
  });

  it("authenticated and unowned: paid, unavailable, free -- three distinct states", () => {
    const reader = (priceAll: number | null) =>
      resolveBookPurchaseState({
        user: { id: "reader-1" },
        isAuthor: false,
        owned: false,
        priceAll,
        paidCheckoutAvailable: true,
      });
    expect(reader(LEGACY_PAID.price_all)).toBe("paid-unowned");
    expect(reader(UNPRICED.price_all)).toBe("unavailable-unowned");
    expect(reader(FREE.price_all)).toBe("free-unowned");
  });

  it("ownership and authorship still outrank price, for all three rows", () => {
    for (const row of [LEGACY_PAID, UNPRICED, FREE]) {
      expect(
        resolveBookPurchaseState({
          user: { id: "r" }, isAuthor: false, owned: true, priceAll: row.price_all,
          paidCheckoutAvailable: true,
        }),
      ).toBe("owned");
      expect(
        resolveBookPurchaseState({
          user: { id: "a" }, isAuthor: true, owned: false, priceAll: row.price_all,
          paidCheckoutAvailable: true,
        }),
      ).toBe("author");
    }
  });

  it("an unpriced book still offers Read Sample -- unavailable is not invisible", () => {
    expect(resolveShowSample("anonymous-unavailable")).toBe(true);
    expect(resolveShowSample("unavailable-unowned")).toBe(true);
  });
});

describe("decision site 4 of 13: resolveCheckoutSecurityNote", () => {
  it("only the paid row gets a checkout note", () => {
    expect(resolveCheckoutSecurityNote({ priceAll: LEGACY_PAID.price_all, usePok: true, paidCheckoutAvailable: true })).toBe(
      " Secure checkout with POK.",
    );
    expect(resolveCheckoutSecurityNote({ priceAll: UNPRICED.price_all, usePok: true, paidCheckoutAvailable: true })).toBeNull();
    expect(resolveCheckoutSecurityNote({ priceAll: FREE.price_all, usePok: true, paidCheckoutAvailable: true })).toBeNull();
  });
});

describe("decision site 5 of 13: resolvePublishReadiness", () => {
  it("the paid row is blocked by the paid-publishing capability, not by a missing price", () => {
    const readiness = resolvePublishReadiness({
      book: LEGACY_PAID,
      paidPublishingAvailable: false,
    });
    expect(readiness.paidPublishingBlocked).toBe(true);
    expect(readiness.missingAllPrice).toBe(false);
  });

  it("the unpriced row reports a missing price and NOT a paid-publishing block", () => {
    // Both at once would offer two explanations for one refusal, and the
    // one the author can act on would be buried under the one they
    // cannot.
    const readiness = resolvePublishReadiness({
      book: UNPRICED,
      paidPublishingAvailable: false,
    });
    expect(readiness.missingAllPrice).toBe(true);
    expect(readiness.paidPublishingBlocked).toBe(false);
  });

  it("the unpriced row is blocked even when paid publishing IS available", () => {
    const readiness = resolvePublishReadiness({
      book: UNPRICED,
      paidPublishingAvailable: true,
    });
    expect(readiness.missingAllPrice).toBe(true);
    expect(readiness.paidPublishingBlocked).toBe(false);
  });

  it("the free row is blocked by neither, at any capability level", () => {
    for (const available of [true, false]) {
      const readiness = resolvePublishReadiness({
        book: FREE,
        paidPublishingAvailable: available,
      });
      expect(readiness.missingAllPrice).toBe(false);
      expect(readiness.paidPublishingBlocked).toBe(false);
    }
  });

  it("the two blockers are mutually exclusive for every catalog value", () => {
    const values: Array<number | null> = [null, undefined as unknown as null, 0, 99, 199, 100000, 50, 100001];
    for (const price_all of values) {
      for (const available of [true, false]) {
        const r = resolvePublishReadiness({
          book: { ...LEGACY_PAID, price_all },
          paidPublishingAvailable: available,
        });
        expect(r.missingAllPrice && r.paidPublishingBlocked).toBe(false);
      }
    }
  });
});

describe("decision site 6 of 13: the publish checklist's price item", () => {
  function priceItem(book: Parameters<typeof getPublishChecklist>[0]) {
    return getPublishChecklist(book).find((item) => item.label.includes("price"));
  }

  it("is done for the paid row and for the free row", () => {
    expect(priceItem(LEGACY_PAID)?.done).toBe(true);
    expect(priceItem(FREE)?.done).toBe(true);
  });

  it("is NOT done for the unpriced row -- the only genuinely incomplete case", () => {
    expect(priceItem(UNPRICED)?.done).toBe(false);
  });

  it("names lek, never dollars", () => {
    const label = priceItem(LEGACY_PAID)?.label ?? "";
    expect(label).toMatch(/lek/i);
    expect(label).not.toContain("$");
    expect(label).not.toMatch(/dollar|USD/i);
  });
});

describe("decision site 7 of 13: the dashboard attention prompt", () => {
  const published = (row: Row) => ({ ...row, status: "published" as const });

  it("the paid row raises the paid-publishing prompt when the capability is absent", () => {
    const state = resolveDashboardAttention({
      books: [published(LEGACY_PAID)],
      paidPublishingAvailable: false,
    });
    expect(state.kind).toBe("paid-publishing-unavailable");
  });

  it("the unpriced row does NOT raise it -- it is not a paid title", () => {
    const state = resolveDashboardAttention({
      books: [published(UNPRICED)],
      paidPublishingAvailable: false,
    });
    expect(state.kind).not.toBe("paid-publishing-unavailable");
  });

  it("the free row does not raise it either", () => {
    const state = resolveDashboardAttention({
      books: [published(FREE)],
      paidPublishingAvailable: false,
    });
    expect(state.kind).not.toBe("paid-publishing-unavailable");
  });
});

describe("decision sites 8-9 of 13: the earnings calculator, logic and its component's inputs", () => {
  it("the paid row earns; the conversion boundary is x100 and happens exactly once", () => {
    const estimate = calculateAuthorEarnings(LEGACY_PAID.price_all as number, 1);
    expect(estimate.grossMinor).toBe(19900);
    expect(estimate.platformFeeMinor + estimate.authorEarningsMinor).toBe(estimate.grossMinor);
  });

  it("an unpriced book earns nothing rather than throwing or inventing a price", () => {
    const estimate = calculateAuthorEarnings(
      UNPRICED.price_all as unknown as number,
      10,
    );
    expect(estimate).toEqual({ grossMinor: 0, platformFeeMinor: 0, authorEarningsMinor: 0 });
  });

  it("the legacy price_cents is never what it earns on", () => {
    // 199 lek is 19900 minor units. The legacy column says 0, and the
    // free row's legacy column says 9900 -- neither may appear.
    expect(calculateAuthorEarnings(LEGACY_PAID.price_all as number, 1).grossMinor).toBe(19900);
    expect(calculateAuthorEarnings(FREE.price_all as number, 1).grossMinor).toBe(0);
  });

  it("the split is exact for every whole-lek price in the domain", () => {
    for (const priceAll of [99, 100, 199, 333, 1000, 12345, 100000]) {
      const e = calculateAuthorEarnings(priceAll, 7);
      expect(e.grossMinor).toBe(priceAll * 100 * 7);
      expect(e.platformFeeMinor + e.authorEarningsMinor).toBe(e.grossMinor);
      expect(Number.isSafeInteger(e.platformFeeMinor)).toBe(true);
      expect(Number.isSafeInteger(e.authorEarningsMinor)).toBe(true);
    }
  });
});

describe("decision site 10 of 13: the upload wizard's price summary", () => {
  it("199 typed by an author is a PAID book worth 19900 minor units", () => {
    const summary = resolveWizardPriceSummary("199");
    expect(summary.priceValid).toBe(true);
    expect(summary.isFreeBook).toBe(false);
    expect(summary.priceAll).toBe(199);
    expect(summary.grossMinor).toBe(19900);
  });

  it("accepts the Albanian comma form as the same price", () => {
    expect(resolveWizardPriceSummary("199,00")).toEqual(resolveWizardPriceSummary("199"));
    expect(resolveWizardPriceSummary("199.00")).toEqual(resolveWizardPriceSummary("199"));
  });

  it("0 is a free book, not an invalid one", () => {
    const summary = resolveWizardPriceSummary("0");
    expect(summary.priceValid).toBe(true);
    expect(summary.isFreeBook).toBe(true);
    expect(summary.grossMinor).toBe(0);
  });

  it("an unenterable price is invalid and quotes nothing", () => {
    for (const input of ["", "  ", "42", "99,50", "1e3", "-99", "100001"]) {
      const summary = resolveWizardPriceSummary(input);
      expect(summary.priceValid).toBe(false);
      expect(summary.grossMinor).toBe(0);
      expect(summary.earningsMinor).toBe(0);
    }
  });

  it("never scales the typed value by 100 into the catalog field", () => {
    expect(resolveWizardPriceSummary("99").priceAll).toBe(99);
    expect(resolveWizardPriceSummary("99").priceAll).not.toBe(9900);
  });

  it("agrees with calculateAuthorEarnings exactly -- one rounding, one owner", () => {
    for (const priceAll of [99, 199, 500, 12345, 100000]) {
      const summary = resolveWizardPriceSummary(String(priceAll));
      const estimate = calculateAuthorEarnings(priceAll, 1);
      expect(summary.grossMinor).toBe(estimate.grossMinor);
      expect(summary.feeMinor).toBe(estimate.platformFeeMinor);
      expect(summary.earningsMinor).toBe(estimate.authorEarningsMinor);
    }
  });
});

describe("no pure decision site reads price_cents at all", () => {
  // The strongest available form of the claim: each function is called
  // with a row whose ONLY price field is the legacy one. If any of them
  // consulted it, they would classify this row as free or paid; they
  // must all treat it as having no ALL price.
  const legacyOnly = {
    ...LEGACY_PAID,
    price_all: undefined as unknown as null,
    price_cents: 9900,
  };

  it("every one of them treats a price_cents-only row as unavailable", () => {
    expect(resolveCatalogPriceState(legacyOnly.price_all)).toBe("unavailable");
    expect(
      resolveBookPurchaseState({
        user: null, isAuthor: false, owned: false, priceAll: legacyOnly.price_all,
        paidCheckoutAvailable: true,
      }),
    ).toBe("anonymous-unavailable");
    expect(
      resolveCheckoutSecurityNote({ priceAll: legacyOnly.price_all, usePok: true, paidCheckoutAvailable: true }),
    ).toBeNull();
    expect(
      resolvePublishReadiness({ book: legacyOnly, paidPublishingAvailable: true }).missingAllPrice,
    ).toBe(true);
    expect(
      getPublishChecklist(legacyOnly).find((item) => item.label.includes("price"))?.done,
    ).toBe(false);
    expect(
      resolveDashboardAttention({
        books: [{ ...legacyOnly, status: "published" }],
        paidPublishingAvailable: false,
      }).kind,
    ).not.toBe("paid-publishing-unavailable");
    expect(
      calculateAuthorEarnings(legacyOnly.price_all as unknown as number, 3).grossMinor,
    ).toBe(0);
  });
});
