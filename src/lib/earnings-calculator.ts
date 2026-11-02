import { resolveCatalogPriceState } from "@/lib/catalog-price";
import { librumShareMinor, royaltyPercentForPaidMinor } from "@/lib/royalty";

// LIBRUM 2.0 PRODUCT-4: this is a public, purely informational estimate
// -- "if I price my book at X, approximately how much does Librum
// allocate to me per eligible sale" -- never a claim about take-home
// pay, net income, or an actual bank payout (see the PRODUCT-4 audit:
// no tax logic exists anywhere in this app, and no provider processing
// fee is deducted from the author's share, so neither belongs in this
// arithmetic).
//
// BD2 (Renato 11-01, 1a): the estimate now follows the DECIDED royalty
// tiers in src/lib/royalty.ts (70% from 199 lek, 50% below), which is
// what the public pages say. It deliberately no longer calls
// platformFeeCents() (src/lib/pricing.ts): that function still drives
// the real 80/20 checkout and ledger until the live POK build (N6)
// switches them to the same tiers. Until then this estimate and a test
// sale on staging disagree on purpose; after N6 they must agree again.
//
// Rounding stays PER SALE: Librum's share is rounded once on a single
// sale's price, then multiplied by the sales count -- never rounded
// once on an already-multiplied gross total. Catalog prices are whole
// lek, so at 70% and 50% there is nothing to round anyway.
export type EarningsEstimate = {
  grossMinor: number;
  librumShareMinor: number;
  authorEarningsMinor: number;
  /** The author's royalty percent for this price; 0 when the estimate is all zero (free, invalid price or no sales). */
  royaltyPercent: number;
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
  const perSaleLibrumMinor = librumShareMinor(perSaleGrossMinor);
  const perSaleEarningsMinor = perSaleGrossMinor - perSaleLibrumMinor;

  return {
    grossMinor: perSaleGrossMinor * safeSales,
    librumShareMinor: perSaleLibrumMinor * safeSales,
    authorEarningsMinor: perSaleEarningsMinor * safeSales,
    royaltyPercent:
      perSaleGrossMinor > 0 && safeSales > 0 ? royaltyPercentForPaidMinor(perSaleGrossMinor) : 0,
  };
}
