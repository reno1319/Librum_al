import { resolveCatalogPriceState } from "@/lib/catalog-price";
import { platformFeeCents } from "@/lib/pricing";

// LIBRUM 2.0 PRODUCT-4: this is a public, purely informational estimate
// -- "if I price my book at X, approximately how much does Librum
// allocate to me per eligible sale" -- never a claim about take-home
// pay, net income, or an actual bank payout (see the PRODUCT-4 audit:
// no tax logic exists anywhere in this app, and no provider processing
// fee is deducted from the author's share, so neither belongs in this
// arithmetic).
//
// The formula and its rounding are NOT independently invented --
// platformFeeCents() (src/lib/pricing.ts) is the exact function behind
// PLATFORM_FEE_PERCENT / AUTHOR_ROYALTY_RATE_BPS, the same 8000 bps
// split create_book_checkout_intent freezes onto every new checkout
// intent and the same one Dashboard Sales shows per purchase.
// Reusing it here, with the same
// PER-SALE rounding those two callers use, is what guarantees this
// calculator can never quietly disagree with real revenue for the same
// hypothetical price: platformFeeCents() is rounded ONCE on a single
// sale's price, then multiplied by the sales count -- never rounded
// once on an already-multiplied gross total, which is a different (and
// wrong) number for most price/sales combinations.
export type EarningsEstimate = {
  grossMinor: number;
  platformFeeMinor: number;
  authorEarningsMinor: number;
};

// ALL-WIRING-2: the inputs and outputs are ALL, not USD. The price is a
// WHOLE-ALL catalog integer (the same domain an author may actually
// save), and every returned figure is in ALL MINOR UNITS -- the unit
// the ledger and the checkout intent already use, and the unit
// formatAllMinorUnits (src/lib/all-money.ts) renders. The conversion
// happens on exactly one line below, mirroring the single `price_all *
// 100` boundary inside create_book_checkout_intent; there is no second
// place in this module where a catalog value becomes a money amount.
//
// Defensive against exactly the malformed inputs a form field can hand
// back -- NaN from an empty field, a negative typed value, a fractional
// sales count, a price outside Librum's own catalog domain. Never
// throws, never returns a negative or NaN figure. Anything that is not
// a valid whole-ALL catalog price is treated as 0, which naturally
// yields an all-zero estimate rather than a fabricated one -- the same
// posture as before, now measured against the real catalog domain
// rather than "any non-negative number".
function sanitizePriceAll(priceAll: number): number {
  return resolveCatalogPriceState(priceAll) === "unavailable" ? 0 : priceAll;
}

function sanitizeSalesCount(sales: number): number {
  if (!Number.isFinite(sales) || sales <= 0) return 0;
  return Math.floor(sales);
}

export function calculateAuthorEarnings(
  priceAll: number,
  sales: number,
): EarningsEstimate {
  const safePriceAll = sanitizePriceAll(priceAll);
  const safeSales = sanitizeSalesCount(sales);

  // THE conversion boundary: whole lek -> integer ALL minor units.
  const perSaleGrossMinor = safePriceAll * 100;
  const perSaleFeeMinor = platformFeeCents(perSaleGrossMinor);
  const perSaleEarningsMinor = perSaleGrossMinor - perSaleFeeMinor;

  return {
    grossMinor: perSaleGrossMinor * safeSales,
    platformFeeMinor: perSaleFeeMinor * safeSales,
    authorEarningsMinor: perSaleEarningsMinor * safeSales,
  };
}
