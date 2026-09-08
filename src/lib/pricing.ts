export const PLATFORM_FEE_PERCENT = 20;

// STRIPE-CUTOVER-2A Section 22: the author's royalty share, expressed in
// basis points, derived directly from PLATFORM_FEE_PERCENT so the two
// can never drift apart -- (100 - 20)% = 80% = 8000 bps. This is the
// value a NEW ledger_v1 checkout freezes ONCE, at checkout-creation
// time, into book_checkout_intents.royalty_rate_bps /
// bundle_checkout_snapshots.royalty_rate_bps (migration 056) -- never
// recomputed later at webhook/finalization time, so a future change to
// PLATFORM_FEE_PERCENT can never silently alter the economics of an
// already-created, not-yet-finalized ledger_v1 checkout.
export const AUTHOR_ROYALTY_RATE_BPS = (100 - PLATFORM_FEE_PERCENT) * 100;

// LIBRUM 2.0 UI-4: the single shared formatter for a book/bundle price
// as shown to readers -- was previously duplicated independently in
// BookCard, the bookstore hero, the bundle list, and the book detail
// page. Currency is fixed at USD to match every other price-facing
// surface in the app (Stripe Checkout, book detail, dashboard sales) --
// not a currency-selection feature. This remains the production default
// for every legacy_stripe_connect_v1 surface (Section 9) -- unchanged by
// STRIPE-CUTOVER-2A.
export function formatPrice(priceCents: number): string {
  return priceCents === 0 ? "Free" : `$${(priceCents / 100).toFixed(2)}`;
}

// STRIPE-CUTOVER-2A Section 9: regime-aware formatter for a ledger_v1
// TEST-mode price, distinct from formatPrice above (which stays fixed at
// "$", legacy/USD) so no existing legacy-facing surface is touched by
// this change. ALL uses two-decimal internal minor units (1 ALL = 100
// minor units, the same "divide by 100" shape as USD cents) -- per the
// locked product decision, this is NOT a currency conversion, just this
// currency's own minor-unit convention, formatted with an explicit "ALL"
// suffix (rather than a symbol) so it can never be visually mistaken for
// a dollar amount.
export function formatAllPrice(priceMinorUnits: number): string {
  return priceMinorUnits === 0 ? "Free" : `${(priceMinorUnits / 100).toFixed(2)} ALL`;
}

export function platformFeeCents(priceCents: number) {
  return Math.round((priceCents * PLATFORM_FEE_PERCENT) / 100);
}

// Stripe declines card charges below $0.50 USD, so a code that would
// discount a book past that floor just charges the floor instead.
export const MIN_CHARGE_CENTS = 50;

export function applyDiscount(
  priceCents: number,
  discount: { percent_off: number | null; amount_off_cents: number | null },
) {
  const discounted =
    discount.percent_off != null
      ? Math.round(priceCents * (1 - discount.percent_off / 100))
      : priceCents - (discount.amount_off_cents ?? 0);

  return Math.max(discounted, MIN_CHARGE_CENTS);
}
