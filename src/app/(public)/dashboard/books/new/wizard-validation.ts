import { classifyCatalogPrice, parseCatalogPriceAll } from "@/lib/catalog-price";
import { calculateAuthorEarnings } from "@/lib/earnings-calculator";

// LIBRUM 2.0 PUBLISHING-UX-1 PART C: pure step-gating decisions for the
// New Book wizard, extracted so upload-wizard.tsx's own "can I go to
// the next step" logic gets direct unit-test coverage -- the same
// "extract a pure decision function, unit-test it directly" pattern
// already used by resolveHomepageCta(), parseBookstoreQuery(),
// resolveBookPurchaseState(), resolveDashboardAttention(), and
// resolvePublishReadiness(). upload-wizard.tsx itself has no React
// DOM-testing-library pattern established anywhere in this codebase,
// so these four functions are deliberately the only part of its step
// gating and price/earnings display with independent test coverage --
// everything else about a step (what it renders, which fields it
// submits) stays in the component, unchanged in kind from before this
// module existed.

export function canAdvanceFromBookDetails(params: {
  title: string;
  language: string;
  genre: string;
}): boolean {
  return (
    params.title.trim().length > 0 &&
    params.language.trim().length > 0 &&
    params.genre.trim().length > 0
  );
}

export function canAdvanceFromFiles(params: {
  coverReady: boolean;
  manuscriptReady: boolean;
}): boolean {
  return params.coverReady && params.manuscriptReady;
}

// ALL-WIRING-2: the step gate is now exactly the server's own parser.
// `Number(price) >= 0` accepted 1, 98, 0.5, 1e3 and "  7 " -- every one
// of which createBook/updateBook now REJECT outright, so the wizard
// would have advanced an author to Review & Publish and then refused
// the save. One parser, one answer.
export function canAdvanceFromPrice(params: { price: string }): boolean {
  return parseCatalogPriceAll(params.price).ok;
}

// ALL-WIRING-2: every money figure here is ALL MINOR UNITS, and
// `priceAll` is the whole-lek catalog integer the author actually
// typed. `priceValid` means "parseCatalogPriceAll accepted it", not
// "Number() produced something non-negative".
export type WizardPriceSummary = {
  priceValid: boolean;
  isFreeBook: boolean;
  priceAll: number;
  grossMinor: number;
  feeMinor: number;
  earningsMinor: number;
};

// LIBRUM 2.0 PUBLISHING-UX-1 PART C: the Price & Earnings step's and
// Review & Publish step's shared price/earnings display math, extracted
// so it gets direct test coverage proving it never disagrees with
// platformFeeCents() -- the SAME function that decides the real
// application_fee_amount at checkout and the real per-purchase earnings
// shown on Dashboard Sales (see src/lib/pricing.ts and
// src/lib/earnings-calculator.ts's own comment for why reusing it,
// rather than reimplementing the 20% split here, is load-bearing).
//
// ALL-WIRING-2: it now delegates to calculateAuthorEarnings() outright
// rather than calling platformFeeCents() beside it, so the wizard, the
// public /pricing calculator and the ledger cannot disagree even by a
// rounding step.
export function resolveWizardPriceSummary(price: string): WizardPriceSummary {
  const parsed = parseCatalogPriceAll(price);

  if (!parsed.ok) {
    return {
      priceValid: false,
      isFreeBook: false,
      priceAll: 0,
      grossMinor: 0,
      feeMinor: 0,
      earningsMinor: 0,
    };
  }

  const priceAll = parsed.priceAll;
  const isFreeBook = classifyCatalogPrice(priceAll) === "free";
  // Delegated, never reimplemented -- calculateAuthorEarnings owns the
  // single whole-ALL -> minor-unit conversion and the single rounding.
  const estimate = calculateAuthorEarnings(priceAll, 1);

  return {
    priceValid: true,
    isFreeBook,
    priceAll,
    grossMinor: estimate.grossMinor,
    feeMinor: estimate.platformFeeMinor,
    earningsMinor: estimate.authorEarningsMinor,
  };
}
