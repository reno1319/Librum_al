import { describe, expect, it } from "vitest";
import {
  resolveBookPurchaseState,
  resolveShowSample,
  resolveCheckoutSecurityNote,
  type BookPurchaseState,
} from "./book-purchase";

describe("resolveBookPurchaseState", () => {
  // Distinct states, not a single collapsed "anonymous" -- a free book
  // must present "Log in to get this book", never "Log in to buy", so
  // the presentation layer needs the price distinction here, not just
  // the auth distinction.
  it("anonymous + paid resolves to anonymous-paid, not the free variant", () => {
    expect(
      resolveBookPurchaseState({ user: null, isAuthor: false, owned: false, priceAll: 199, paidCheckoutAvailable: true }),
    ).toBe("anonymous-paid");
  });

  it("anonymous + free resolves to anonymous-free, not the paid variant", () => {
    expect(
      resolveBookPurchaseState({ user: null, isAuthor: false, owned: false, priceAll: 0, paidCheckoutAvailable: true }),
    ).toBe("anonymous-free");
  });

  it("reader, unowned, paid", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "reader-1" },
        isAuthor: false,
        owned: false,
        priceAll: 199,
        paidCheckoutAvailable: true,
      }),
    ).toBe("paid-unowned");
  });

  it("reader, unowned, free", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "reader-1" },
        isAuthor: false,
        owned: false,
        priceAll: 0,
        paidCheckoutAvailable: true,
      }),
    ).toBe("free-unowned");
  });

  it("reader, owned (regardless of price)", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "reader-1" },
        isAuthor: false,
        owned: true,
        priceAll: 199,
        paidCheckoutAvailable: true,
      }),
    ).toBe("owned");
  });

  it("author viewing their own book takes precedence over owned", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "author-1" },
        isAuthor: true,
        owned: true,
        priceAll: 199,
        paidCheckoutAvailable: true,
      }),
    ).toBe("author");
  });

  it("author viewing their own free book still resolves to author, not free-unowned", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "author-1" },
        isAuthor: true,
        owned: false,
        priceAll: 0,
        paidCheckoutAvailable: true,
      }),
    ).toBe("author");
  });
});

// LIBRUM 2.0 PRODUCT-5 EPUB-SAMPLE-AVAILABILITY CORRECTION: a
// production report investigated a published DOCX-converted book
// showing no Read Sample on Book Detail. Root cause: the report's own
// screenshots were the book's AUTHOR viewing their OWN page, where Read
// Sample has ALWAYS been intentionally omitted (PRODUCT-1's own design
// -- an author already has Download EPUB) -- not a defect in DOCX-
// generated EPUBs, the sample extractor, or any DB field PRODUCT-5
// touches. This was previously an untested inline computation directly
// in Book Detail's Server Component; extracted here (alongside
// resolveBookPurchaseState, the same "extract a pure decision function,
// unit-test it directly" pattern this file already establishes) so the
// exact rule is pinned going forward, for every BookPurchaseState, with
// zero dependency on manuscript origin (DOCX vs. direct EPUB) -- there
// is no such input to this function at all, by construction.
describe("resolveShowSample", () => {
  const shown: BookPurchaseState[] = [
    "anonymous-paid",
    "anonymous-free",
    "anonymous-unavailable",
    "free-unowned",
    "paid-unowned",
    "unavailable-unowned",
  ];
  const hidden: BookPurchaseState[] = ["author", "owned"];

  it.each(shown)("shows Read Sample for %s", (state) => {
    expect(resolveShowSample(state)).toBe(true);
  });

  it.each(hidden)(
    "omits Read Sample for %s -- already has full access via Download EPUB",
    (state) => {
      expect(resolveShowSample(state)).toBe(false);
    },
  );
});

// STRIPE-DISABLE-1 CORRECTION: proves the book purchase area can no
// longer render "Secure checkout with Stripe." -- accurate before new
// Stripe checkout creation was disabled, false now that buyBook can
// never reach Stripe. The POK-specific wording is unaffected.
describe("resolveCheckoutSecurityNote", () => {
  it("free book: no note at all, regardless of provider", () => {
    expect(resolveCheckoutSecurityNote({ priceAll: 0, usePok: true, paidCheckoutAvailable: true })).toBeNull();
    expect(resolveCheckoutSecurityNote({ priceAll: 0, usePok: false, paidCheckoutAvailable: true })).toBeNull();
  });

  it("paid book, POK enabled: names POK", () => {
    expect(resolveCheckoutSecurityNote({ priceAll: 199, usePok: true, paidCheckoutAvailable: true })).toBe(
      " Secure checkout with POK.",
    );
  });

  it("paid book, POK not enabled (checkout disabled): neutral wording, never names Stripe", () => {
    const note = resolveCheckoutSecurityNote({ priceAll: 199, usePok: false, paidCheckoutAvailable: true });
    expect(note).toBe(" Secure checkout.");
    expect(note).not.toContain("Stripe");
  });
});

// ALL-WIRING-2: the whole point of the two new states. Every one of
// these asserts that a null `price_all` resolves to an UNAVAILABLE
// state -- never to a free or a paid one -- because both of the old
// branches would have rendered an acquisition control the storefront
// cannot honour. A single `priceAll === 0 ? free : paid` comparison
// classifies null as PAID (null === 0 is false), which is the exact
// mis-classification these tests exist to catch.
describe("resolveBookPurchaseState: null price_all is never free and never paid", () => {
  it("anonymous + null resolves to anonymous-unavailable", () => {
    expect(
      resolveBookPurchaseState({ user: null, isAuthor: false, owned: false, priceAll: null, paidCheckoutAvailable: true }),
    ).toBe("anonymous-unavailable");
  });

  it("reader, unowned, null resolves to unavailable-unowned", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "reader-1" },
        isAuthor: false,
        owned: false,
        priceAll: null,
        paidCheckoutAvailable: true,
      }),
    ).toBe("unavailable-unowned");
  });

  it("an owner of a now-unpriced book keeps their owned state and their download", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "reader-1" },
        isAuthor: false,
        owned: true,
        priceAll: null,
        paidCheckoutAvailable: true,
      }),
    ).toBe("owned");
  });

  it("the author of an unpriced book still resolves to author, so they can go and price it", () => {
    expect(
      resolveBookPurchaseState({
        user: { id: "author-1" },
        isAuthor: true,
        owned: false,
        priceAll: null,
        paidCheckoutAvailable: true,
      }),
    ).toBe("author");
  });

  // The legacy default row shape: a real ALL price of 199 lek beside a
  // `price_cents` of 0. Nothing in this module reads price_cents at
  // all -- there is no such parameter -- so the only way this could
  // come back "free" is if someone reintroduced one.
  it("price_all 199 with a legacy price_cents 0 is PAID for every reader state", () => {
    expect(
      resolveBookPurchaseState({ user: null, isAuthor: false, owned: false, priceAll: 199, paidCheckoutAvailable: true }),
    ).toBe("anonymous-paid");
    expect(
      resolveBookPurchaseState({
        user: { id: "reader-1" },
        isAuthor: false,
        owned: false,
        priceAll: 199,
        paidCheckoutAvailable: true,
      }),
    ).toBe("paid-unowned");
  });

  it("an out-of-domain value is treated as unavailable, never as paid", () => {
    // 50 cannot exist in the column (books_price_all_range_check), so
    // this asserts the fail-safe direction of the classification, not a
    // reachable row.
    expect(
      resolveBookPurchaseState({ user: null, isAuthor: false, owned: false, priceAll: 50, paidCheckoutAvailable: true }),
    ).toBe("anonymous-unavailable");
  });
});

// ALL-WIRING-2: an unpriced book has no checkout, so it has no checkout
// note either. Asserted separately from the free case because the two
// reach the null return through different branches of the three-way
// classification.
describe("resolveCheckoutSecurityNote: unpriced books", () => {
  it("null price: no note, regardless of provider", () => {
    expect(resolveCheckoutSecurityNote({ priceAll: null, usePok: true, paidCheckoutAvailable: true })).toBeNull();
    expect(resolveCheckoutSecurityNote({ priceAll: null, usePok: false, paidCheckoutAvailable: true })).toBeNull();
  });
});

// PAID-CHECKOUT-SURFACE-1: the paid-checkout capability is an input to the
// purchase state, so no paid-unowned or anonymous-paid state (the only two
// that offer a paid checkout) can exist while it is denied.
describe("resolveBookPurchaseState: paid checkout closed", () => {
  const closed = (user: { id: string } | null, priceAll: number | null, extra = {}) =>
    resolveBookPurchaseState({
      user, isAuthor: false, owned: false, priceAll, paidCheckoutAvailable: false, ...extra,
    });

  it("a paid book resolves to the checkout-closed states, never to a checkout-offering one", () => {
    expect(closed(null, 199)).toBe("anonymous-paid-checkout-closed");
    expect(closed({ id: "r" }, 199)).toBe("paid-unowned-checkout-closed");
  });

  it("free, unpriced, author and owner states do not depend on the capability", () => {
    expect(closed(null, 0)).toBe("anonymous-free");
    expect(closed({ id: "r" }, 0)).toBe("free-unowned");
    expect(closed(null, null)).toBe("anonymous-unavailable");
    expect(closed({ id: "r" }, null)).toBe("unavailable-unowned");
    expect(closed({ id: "a" }, 199, { isAuthor: true })).toBe("author");
    expect(closed({ id: "r" }, 199, { owned: true })).toBe("owned");
  });

  it("the sample is still offered in both closed states", () => {
    expect(resolveShowSample("anonymous-paid-checkout-closed")).toBe(true);
    expect(resolveShowSample("paid-unowned-checkout-closed")).toBe(true);
  });

  it("no checkout note is claimed while paid checkout is closed, POK or not", () => {
    expect(resolveCheckoutSecurityNote({ priceAll: 199, usePok: true, paidCheckoutAvailable: false })).toBeNull();
    expect(resolveCheckoutSecurityNote({ priceAll: 199, usePok: false, paidCheckoutAvailable: false })).toBeNull();
  });
});
