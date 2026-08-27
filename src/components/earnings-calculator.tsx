"use client";

import { useState } from "react";
import { PLATFORM_FEE_PERCENT } from "@/lib/pricing";
import { calculateAuthorEarnings } from "@/lib/earnings-calculator";
import { formControlClasses } from "@/lib/form-styles";

// LIBRUM 2.0 PRODUCT-4: an estimate, not a claim about take-home pay --
// see calculateAuthorEarnings (src/lib/earnings-calculator.ts) for why
// this deliberately never subtracts taxes or a Stripe processing fee
// (Librum's own Connect setup absorbs Stripe's fee on its own account,
// confirmed by auditing the actual checkout charge; no tax logic
// exists anywhere in this app to model). Purely informational: no
// network request, no Supabase/Stripe call, no form submission -- it's
// a "use client" island for live recompute-on-type only, the rest of
// /pricing stays a Server Component.
function centsToDollarString(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function EarningsCalculator() {
  const [priceInput, setPriceInput] = useState("9.99");
  const [salesInput, setSalesInput] = useState("1");

  // Same dollar-string -> integer-cents conversion this codebase already
  // uses for a real book's price (see createBook/updateBook in
  // src/app/dashboard/books/actions.ts) -- Math.round guards against the
  // same floating-point drift a plain `price * 100` would otherwise
  // introduce for values like 0.99.
  const priceNum = Number(priceInput);
  const priceValid = Number.isFinite(priceNum) && priceNum >= 0;
  const priceCents = priceValid ? Math.round(priceNum * 100) : 0;

  const salesNum = Number(salesInput);
  const salesValid = Number.isFinite(salesNum) && Number.isInteger(salesNum) && salesNum >= 1;

  const isFreeBook = priceValid && priceCents === 0;
  const showBreakdown = priceValid && salesValid && !isFreeBook;

  const estimate = showBreakdown
    ? calculateAuthorEarnings(priceCents, salesNum)
    : { grossCents: 0, platformFeeCents: 0, authorEarningsCents: 0 };

  return (
    <div className="rounded-lg border border-border bg-surface p-6 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        Earnings calculator
      </p>

      <div className="mt-4 flex flex-wrap gap-4">
        <label className="flex flex-1 min-w-40 flex-col gap-1 text-sm">
          Book price (USD)
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
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
            Enter a book price and a whole number of sales (1 or more) to see an estimate.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-muted">Gross sales</span>
                <span className="font-serif text-lg font-semibold text-foreground">
                  {centsToDollarString(estimate.grossCents)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-muted">Librum platform fee ({PLATFORM_FEE_PERCENT}%)</span>
                <span className="font-serif text-lg font-semibold text-muted">
                  -{centsToDollarString(estimate.platformFeeCents)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
                <span className="font-medium text-foreground">Estimated author earnings</span>
                <span className="font-serif text-xl font-semibold text-primary">
                  {centsToDollarString(estimate.authorEarningsCents)}
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
