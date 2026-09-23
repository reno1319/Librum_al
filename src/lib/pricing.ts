// ALL-WIRING-2 rounding note, recorded because it is true TODAY and may
// stop being true later. The author royalty rate this constant implies
// is 8000 basis points (see AUTHOR_ROYALTY_RATE_BPS below), and at
// exactly 8000 bps an exact half-minor-unit tie is arithmetically
// UNREACHABLE for every catalog price in Librum's domain: every stored
// ALL amount is a whole number of lek converted at 100 minor units per
// lek, so a 20% share of it is always a whole number of minor units.
// Nothing in this codebase therefore depends on which way a tie would
// break. That is a property of the RATE, not a property of the formula:
// change PLATFORM_FEE_PERCENT to a value whose basis-point share is an
// even divisor of the minor-unit grid (7.5% / 7500 bps is one) and real
// ties appear, at which point PostgreSQL's numeric round() -- which is
// half-away-from-zero, unlike IEEE-754 half-to-even -- becomes an
// economically visible decision about who keeps the half minor unit.
// Revisit the ledger's rounding policy BEFORE changing this number; do
// not change the rate or the allocation formula here to "fix" it.
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

// ALL-WIRING-5: formatPrice (`0 -> "Free"`, otherwise `$` + cents/100)
// is gone. Its last callers were the bookstore and author-page bundle
// rails, which now label bundles.price_all through
// formatCatalogPriceLabel (src/lib/catalog-price.ts) like every book
// surface. It was the catalog's USD formatter; with no USD catalog left
// to format, keeping it would only invite the next `$` back in.

// ALL-TXN-CURRENCY-4: formatAllPrice (a "divide by 100, toFixed(2)"
// ALL formatter that rendered "179.10 ALL" against the rest of the app's
// "179,10 ALL") is gone. Its one caller, the held-quote notice on Book
// Detail, now renders the frozen intent amount through
// formatTransactionAmount (src/lib/transaction-money.ts) in the intent's
// own stored currency.

// The platform's share of one sale, in the SAME minor units it is given.
// The name says "cents" for its original legacy USD callers; the
// arithmetic is unit-agnostic, which is why the ALL earnings estimate
// (src/lib/earnings-calculator.ts) feeds it ALL minor units rather than
// reimplementing the split. The author's share is the REMAINDER, never
// a second independent rounding -- that is what makes the two shares
// sum to the gross exactly, for every input.
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
