export const PLATFORM_FEE_PERCENT = 20;

// LIBRUM 2.0 UI-4: the single shared formatter for a book/bundle price
// as shown to readers -- was previously duplicated independently in
// BookCard, the bookstore hero, the bundle list, and the book detail
// page. Currency is fixed at USD to match every other price-facing
// surface in the app (Stripe Checkout, book detail, dashboard sales) --
// not a currency-selection feature.
export function formatPrice(priceCents: number): string {
  return priceCents === 0 ? "Free" : `$${(priceCents / 100).toFixed(2)}`;
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
