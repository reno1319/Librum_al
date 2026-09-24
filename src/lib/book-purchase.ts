import { resolveCatalogPriceState } from "@/lib/catalog-price";

// LIBRUM 2.0 UI-5: the book detail purchase area branches on six
// distinct states (a logged-out visitor -- split by whether the book is
// paid or free, since "Log in to buy" is wrong copy for a free book;
// the book's own author; an owner; an unowned free book; an unowned
// paid book) that were previously expressed as a deeply nested ternary
// directly in the page's JSX. Extracted as a pure function -- same
// "extract a pure decision function, unit-test it directly" pattern
// already used by src/lib/homepage.ts's resolveHomepageCta() and
// src/lib/bookstore.ts's parseBookstoreQuery() -- purely to classify
// which state applies; the actual CTA labels/hrefs/forms stay in the
// page, since those involve JSX (Links vs. server-action forms), not
// pure data.
//
// ALL-WIRING-2: two states join the six. `books.price_all is null` means
// the book has no authored ALL price, so it can be neither bought nor
// claimed free -- and "Log in to buy" / "Get ebook - Free" are both
// FALSE statements about such a row. Those two states exist so the page
// can render the detail page (which stays reachable by product
// decision) with no acquisition form of either kind, rather than
// picking whichever of the paid/free branches a bare numeric comparison
// happened to fall into.
//
// PAID-CHECKOUT-SURFACE-1: two more states, for a PAID book while paid
// checkout is closed (canStartPaidCheckout() false, which is every
// deployment without the exact controlled-staging checkout mode). Before
// them, "anonymous-paid" and "paid-unowned" were chosen from the price
// alone, so the page offered "Log in to buy", a promo field, a Buy
// button and a checkout-resume form that buyBook was always going to
// refuse. A control the server will refuse is a false statement in its
// own right, whatever the server does afterwards. The closed states keep
// the price visible and offer no checkout initiation or resume surface.
//
// The capability is an INPUT, never read here: this module stays pure,
// and the one server-only interpretation of PAID_CHECKOUT_MODE remains
// canStartPaidCheckout() (src/lib/paid-readiness.ts).
export type BookPurchaseState =
  | "anonymous-paid"
  | "anonymous-paid-checkout-closed"
  | "anonymous-free"
  | "anonymous-unavailable"
  | "author"
  | "owned"
  | "free-unowned"
  | "paid-unowned"
  | "paid-unowned-checkout-closed"
  | "unavailable-unowned";

export function resolveBookPurchaseState(params: {
  user: { id: string } | null;
  isAuthor: boolean;
  owned: boolean;
  priceAll: number | null;
  // Required, not optional: every caller must say whether paid checkout
  // is open, so no call site can default into offering one.
  paidCheckoutAvailable: boolean;
}): BookPurchaseState {
  const { user, isAuthor, owned, priceAll, paidCheckoutAvailable } = params;
  const priceState = resolveCatalogPriceState(priceAll);

  if (!user) {
    if (priceState === "unavailable") return "anonymous-unavailable";
    if (priceState === "free") return "anonymous-free";
    return paidCheckoutAvailable ? "anonymous-paid" : "anonymous-paid-checkout-closed";
  }
  // An author viewing their own book takes precedence over owned/free --
  // an author's own book was never actually purchased or claimed free,
  // so "owned"/"free-unowned" would be a misleading label for them even
  // if user_owns_book() happened to also be true. Both precedences
  // survive the unavailable state deliberately: an author must still be
  // able to reach Manage book to SET the missing price, and a reader who
  // already owns the book must still be able to download it. Neither
  // state renders an acquisition form, so neither can start a purchase.
  if (isAuthor) return "author";
  if (owned) return "owned";
  if (priceState === "unavailable") return "unavailable-unowned";
  if (priceState === "free") return "free-unowned";
  return paidCheckoutAvailable ? "paid-unowned" : "paid-unowned-checkout-closed";
}

// LIBRUM 2.0 PRODUCT-1: Read Sample is independent of the purchase
// state's own classification above -- this doesn't add a new state, it
// only decides where the CTA appears. Extracted alongside
// resolveBookPurchaseState() (previously an untested inline computation
// directly in Book Detail's Server Component) after a PRODUCT-5 report
// investigated a published DOCX-converted book showing no Read Sample --
// root cause confirmed to be this EXACT pre-existing rule (see the
// PRODUCT-5 EPUB-sample-availability correction's own report), triggered
// because the report's own screenshots were the book's AUTHOR viewing
// their OWN page, not a defect in DOCX-generated EPUBs or the sample
// pipeline. Shown for every state where the reader doesn't already have
// full access (anonymous or unowned, paid or free); omitted for "owned"/
// "author", who already have Download EPUB, per the PRODUCT-1 brief's
// own explicit permission to omit it there -- identical behavior for
// every book regardless of whether its manuscript was uploaded directly
// as an EPUB or converted from DOCX.
//
// ALL-WIRING-2: the two unavailable states are included for the same
// reason every other non-owner state is -- the rule is "the reader does
// not already have full access", and a missing catalog price changes
// nothing about that. A sample is not an acquisition: it starts no
// checkout, creates no entitlement, and reading one is the only useful
// thing left on a page whose book cannot currently be obtained.
//
// PAID-CHECKOUT-SURFACE-1: the two checkout-closed states are included
// for the same reason -- the reader still lacks full access.
export function resolveShowSample(state: BookPurchaseState): boolean {
  return (
    state === "anonymous-paid" ||
    state === "anonymous-paid-checkout-closed" ||
    state === "anonymous-free" ||
    state === "anonymous-unavailable" ||
    state === "free-unowned" ||
    state === "paid-unowned" ||
    state === "paid-unowned-checkout-closed" ||
    state === "unavailable-unowned"
  );
}

// STRIPE-DISABLE-1 CORRECTION: this used to read "Secure checkout with
// Stripe." for every non-POK book, an untested inline ternary directly
// in Book Detail's Server Component -- accurate before this patch, but
// FALSE now that new Stripe checkout creation is disabled (buyBook can
// no longer reach Stripe at all). Extracted as a pure function (the same
// pattern already established by resolveBookPurchaseState/
// resolveShowSample above) so the exact wording is pinned and testable.
// Deliberately neutral ("Secure checkout.") rather than naming a
// provider for the non-POK case -- this is the smallest wording fix for
// the inaccuracy, not a UI redesign: whether the note is shown at all,
// and the POK-specific wording, are both unchanged.
//
// ALL-WIRING-2: the input is the book's own `price_all`, classified
// three ways. A checkout note belongs only to a book that can actually
// be checked out, so BOTH "free" and "unavailable" return null -- an
// unpriced book has no checkout to describe, and claiming a secure one
// exists would be the same kind of false statement this function was
// extracted to stop.
//
// PAID-CHECKOUT-SURFACE-1: and no note at all while paid checkout is
// closed -- describing a secure checkout, POK or otherwise, that the
// page does not offer is the same false statement.
export function resolveCheckoutSecurityNote(params: {
  priceAll: number | null;
  usePok: boolean;
  paidCheckoutAvailable: boolean;
}): string | null {
  if (!params.paidCheckoutAvailable) return null;
  if (resolveCatalogPriceState(params.priceAll) !== "paid") return null;
  return params.usePok ? " Secure checkout with POK." : " Secure checkout.";
}
