import { platformFeeCents } from "@/lib/pricing";

// LIBRUM 2.0 PRODUCT-4: this is a public, purely informational estimate
// -- "if I price my book at X, approximately how much does Librum
// allocate to me per eligible sale" -- never a claim about take-home
// pay, net income, or an actual bank payout (see the PRODUCT-4 audit:
// no tax logic exists anywhere in this app, and Stripe's own processing
// fee is absorbed by Librum's platform account under the destination-
// charge model in src/app/books/[id]/actions.ts, never deducted from
// the author's share, so neither belongs in this arithmetic).
//
// The formula and its rounding are NOT independently invented --
// platformFeeCents() (src/lib/pricing.ts) is the exact function that
// already decides both the real application_fee_amount Stripe is
// charged at checkout (src/app/books/[id]/actions.ts) and the real
// per-purchase netCents() shown on Dashboard Sales
// (src/app/dashboard/sales/page.tsx). Reusing it here, with the same
// PER-SALE rounding those two callers use, is what guarantees this
// calculator can never quietly disagree with real revenue for the same
// hypothetical price: platformFeeCents() is rounded ONCE on a single
// sale's price, then multiplied by the sales count -- never rounded
// once on an already-multiplied gross total, which is a different (and
// wrong) number for most price/sales combinations.
export type EarningsEstimate = {
  grossCents: number;
  platformFeeCents: number;
  authorEarningsCents: number;
};

// Defensive against exactly the malformed inputs a number input can
// hand back (NaN from an empty/invalid field, a negative typed value, a
// fractional sales count) -- never throws, never returns a negative or
// NaN figure. A non-finite or non-positive price/sales count is treated
// as 0, which naturally yields an all-zero estimate rather than a
// fabricated one.
function sanitizePriceCents(priceCents: number): number {
  if (!Number.isFinite(priceCents) || priceCents <= 0) return 0;
  return Math.round(priceCents);
}

function sanitizeSalesCount(sales: number): number {
  if (!Number.isFinite(sales) || sales <= 0) return 0;
  return Math.floor(sales);
}

export function calculateAuthorEarnings(
  priceCents: number,
  sales: number,
): EarningsEstimate {
  const safePriceCents = sanitizePriceCents(priceCents);
  const safeSales = sanitizeSalesCount(sales);

  const perSaleFeeCents = platformFeeCents(safePriceCents);
  const perSaleEarningsCents = safePriceCents - perSaleFeeCents;

  return {
    grossCents: safePriceCents * safeSales,
    platformFeeCents: perSaleFeeCents * safeSales,
    authorEarningsCents: perSaleEarningsCents * safeSales,
  };
}
