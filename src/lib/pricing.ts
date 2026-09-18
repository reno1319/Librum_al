import { formatAllMinorUnits } from "@/lib/catalog-price";

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

// ALL-CATALOG-2: the single shared reader-facing price formatter.
//
// Was fixed at USD ("$9.99") while POK charged the same stored number as
// ALL minor units -- a book advertised at $9.99 took 9.99 ALL. Librum's
// catalog and checkout currency is ALL only (see catalog-price.ts, and
// POK_STAGING.md's "ALL is the ledger's frozen currency; no USD-to-ALL
// exchange is performed"), so there is no second currency for this
// function to choose between and no regime for it to be aware of.
//
// Takes stored minor units (hundredths of a lek) -- the unit
// books.price_cents, bundles.price_cents and purchases.amount_cents all
// hold. Delegates to catalog-price.ts's lenient formatter rather than
// formatting here, so the Albanian convention (dot groups thousands,
// comma separates decimals) has exactly one implementation. Lenient by
// design: this renders historical purchase amounts and legacy rows that
// are not valid catalog prices, and a display formatter that throws
// takes the whole page down with it.
export function formatPrice(priceMinorUnits: number): string {
  return priceMinorUnits === 0 ? "Free" : formatAllMinorUnits(priceMinorUnits);
}

// formatAllPrice() is gone, not renamed. It existed only so the single
// book detail page could show ALL while every other surface showed USD
// -- a split that was itself the defect. formatPrice above is now the
// one formatter, so the regime branch at its only call site
// (src/app/(public)/books/[id]/page.tsx) is gone too.

export function platformFeeCents(priceCents: number) {
  return Math.round((priceCents * PLATFORM_FEE_PERCENT) / 100);
}

// ALL-CATALOG-2: MIN_CHARGE_CENTS is 50 US cents -- Stripe's old
// minimum charge. It is kept ONLY as the subject of the two guard tests
// that assert it never leaks into an ALL amount (see
// src/app/(public)/books/[id]/checkout-logic.test.ts's "never reuses
// MIN_CHARGE_CENTS as an ALL business rule"). Nothing in any production
// path reads it, and nothing should: in lek minor units 50 is half a
// lek.
//
// applyDiscount() is gone with the currency cutover. It was already
// unreachable -- the discount arithmetic that actually runs lives in
// create_book_checkout_intent (supabase/schema.sql) -- and it carried
// this same USD floor. That SQL function had inherited the identical
// literal, which is how a would-be 0.50 ALL order became possible; see
// supabase/migrations/20260918120000_all_discount_floor.sql. Leaving a
// dead USD-cents helper next to a live ALL catalog is how that mistake
// gets made a second time.
export const MIN_CHARGE_CENTS = 50;
