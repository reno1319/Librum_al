"use client";

import { useState } from "react";
import { ROYALTY_TIERS_LINE } from "@/lib/royalty";
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
// only, the rest of /fitimet stays a Server Component.
//
// ALL-WIRING-2: prices are ALL. The input is a text field with a
// decimal keyboard rather than `type="number"`, because the Albanian
// binding form uses a COMMA decimal separator and a number input's
// value property silently drops what it considers invalid -- "990,00"
// was literally unreachable through the old control. Every figure it
// renders goes through formatAllMinorUnits, so no `$` can appear here.
//
// AUTHOR PAGES REDESIGN: a white two-column box (inputs left, estimate
// right; stacked on phones).
//
// BD2 (Renato 11-01, 2a): Librum sells the book and pays the author a
// royalty ("honorar"), so the middle row is Librum's share, not a
// "platform fee", and both percents follow the price (src/lib/royalty.ts).
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
    : { grossMinor: 0, librumShareMinor: 0, authorEarningsMinor: 0, royaltyPercent: 0 };

  return (
    <div className="grid gap-8 rounded-[4px] border border-border bg-surface p-5 sm:p-7 md:grid-cols-2">
      <div className="flex flex-col gap-4">
        <p className="text-[0.8125rem] font-semibold uppercase tracking-[0.14em] text-[#8a6d12]">
          Llogaritësi i fitimeve
        </p>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Çmimi i librit (lekë)</span>
          <input
            type="text"
            inputMode="decimal"
            value={priceInput}
            onChange={(e) => setPriceInput(e.target.value)}
            aria-invalid={!priceValid}
            className={`${formControlClasses} w-full`}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-semibold">Numri i shitjeve</span>
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

      <div aria-live="polite" className="border-t border-border pt-6 md:border-t-0 md:border-l md:pt-0 md:pl-8">
        {isFreeBook ? (
          <div>
            <p className="font-serif text-lg font-semibold text-foreground">Libër falas</p>
            <p className="mt-1 text-sm text-muted">Autori nuk fiton nga shitjet.</p>
          </div>
        ) : !priceValid || !salesValid ? (
          <p className="text-sm text-muted">
            Shkruani një çmim në lekë (0, ose nga 99 deri në 100.000) dhe një numër
            të plotë shitjesh (1 ose më shumë) për të parë një vlerësim.
          </p>
        ) : (
          <>
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-muted">Shitjet bruto</span>
                <span className="whitespace-nowrap font-serif text-lg font-semibold text-foreground">
                  {formatAllMinorUnits(estimate.grossMinor)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-muted">Pjesa e Librum ({100 - estimate.royaltyPercent}%)</span>
                <span className="whitespace-nowrap font-serif text-lg font-semibold text-muted">
                  -{formatAllMinorUnits(estimate.librumShareMinor)}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3">
                <span className="font-medium text-foreground">
                  Honorari i vlerësuar i autorit ({estimate.royaltyPercent}%)
                </span>
                <span className="whitespace-nowrap font-serif text-[2rem] leading-none font-normal text-primary">
                  {formatAllMinorUnits(estimate.authorEarningsMinor)}
                </span>
              </div>
            </div>
            <p className="mt-4 text-xs text-muted">{ROYALTY_TIERS_LINE}</p>
            <p className="mt-1 text-xs text-muted">
              Para taksave dhe tarifave të mundshme bankare ose të këmbimit valutor.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
