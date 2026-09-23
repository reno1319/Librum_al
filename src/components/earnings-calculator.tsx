"use client";

import { useState } from "react";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { formatAllMinorUnits } from "@/lib/all-money";
import { classifyCatalogPrice, parseCatalogPriceAll } from "@/lib/catalog-price";
import { calculateAuthorEarnings } from "@/lib/earnings-calculator";
import { formControlClasses } from "@/lib/form-styles";

// LIBRUM 2.0 PRODUCT-4: an estimate, not a claim about take-home pay --
// see calculateAuthorEarnings (src/lib/earnings-calculator.ts) for why
// this deliberately never subtracts taxes or a provider processing fee
// (no tax logic exists anywhere in this app to model). Purely
// informational: no network request, no Supabase/provider call, no form
// submission -- it's a "use client" island for live recompute-on-type
// only, the rest of /pricing stays a Server Component.
//
// ALL-WIRING-2: prices are ALL. The input is a text field with a
// decimal keyboard rather than `type="number"`, because the Albanian
// binding form uses a COMMA decimal separator and a number input's
// value property silently drops what it considers invalid -- "990,00"
// was literally unreachable through the old control. Every figure it
// renders goes through formatAllMinorUnits, so no `$` can appear here.
export function EarningsCalculator() {
  const [priceInput, setPriceInput] = useState("990");
  const [salesInput, setSalesInput] = useState("1");

  // ALL-WIRING-2: exactly the parser createBook/updateBook use on the
  // server, so this calculator can never quote an estimate for a price
  // an author could not actually save. It accepts the same binding
  // forms ("990", "990,00", "990.00") and refuses everything else --
  // fractional lek, 1..98, above 100000, signs, exponents.
  const parsedPrice = parseCatalogPriceAll(priceInput);
  const priceValid = parsedPrice.ok;
  const priceAll = parsedPrice.ok ? parsedPrice.priceAll : 0;

  const salesNum = Number(salesInput);
  const salesValid = Number.isFinite(salesNum) && Number.isInteger(salesNum) && salesNum >= 1;

  const isFreeBook = priceValid && classifyCatalogPrice(priceAll) === "free";
  const showBreakdown = priceValid && salesValid && !isFreeBook;

  const estimate = showBreakdown
    ? calculateAuthorEarnings(priceAll, salesNum)
    : { grossMinor: 0, platformFeeMinor: 0, authorEarningsMinor: 0 };

  return (
    <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        Earnings calculator
      </p>

      <div className="mt-4 flex flex-wrap gap-4">
        <label className="flex flex-1 min-w-40 flex-col gap-1 text-sm">
          Book price (ALL)
          <input
            type="text"
            inputMode="decimal"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            aria-invalid={!priceValid}
            className={`${formControlClasses} w-full`}
          />
        </label>
        <label className="flex flex-1 min-w-40 flex-col gap-1 text-sm">
          Number of sales
          <input
            type="number"
            inputMode="numeric"
            min="1"
            step="1"
            value={salesInput}
            onChange={(e) => setSalesInput(e.target.value)}
            aria-invalid={!salesValid}
            className={`${formControlClasses} w-full`}
          />
        </label>
      </div>

      <div aria-live="polite" className="mt-6 border-t border-border pt-6">
        {isFreeBook ? (
          <div>
            <p className="font-serif text-lg font-semibold text-foreground">Free book</p>
            <p className="mt-1 text-sm text-muted">No author earnings from sales.</p>
          </div>
        ) : !priceValid || !salesValid ? (
          <p className="text-sm text-muted">
            Enter a price in lek (0, or 99 to 100.000) and a whole number of
            sales (1 or more) to see an estimate.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-muted">Gross sales</span>
                <span className="font-serif text-lg font-semibold text-foreground">
                  {formatAllMinorUnits(estimate.grossMinor)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-muted">Librum platform fee ({PLATFORM_FEE_PERCENT}%)</span>
                <span className="font-serif text-lg font-semibold text-muted">
                  -{formatAllMinorUnits(estimate.platformFeeMinor)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
                <span className="font-medium text-foreground">Estimated author earnings</span>
                <span className="font-serif text-xl font-semibold text-primary">
                  {formatAllMinorUnits(estimate.authorEarningsMinor)}
                </span>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted">
              Before taxes and any banking or currency-conversion fees that may apply.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
