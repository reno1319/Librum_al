import { platformFeeCents } from "@/lib/pricing";
import { catalogPriceAllToMinor, parseCatalogPriceAll } from "@/lib/catalog-price";

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

// ALL-CATALOG-2: was `Number(price) >= 0`, which accepted anything
// non-negative -- 0.01, 7.5, 1e9 -- and then rounded it to cents. The
// catalog domain is whole lek: exactly 0, or 99 through 100,000. That
// rule now lives in exactly one place (parseCatalogPriceAll), so this
// gate and the Server Action that ultimately writes the row can never
// disagree about what a valid price is.
export function canAdvanceFromPrice(params: { price: string }): boolean {
  return parseCatalogPriceAll(params.price).ok;
}

export type WizardPriceSummary = {
  priceValid: boolean;
  isFreeBook: boolean;
  priceCents: number;
  feeCents: number;
  earningsCents: number;
};

// LIBRUM 2.0 PUBLISHING-UX-1 PART C: the Price & Earnings step's and
// Review & Publish step's shared price/earnings display math, extracted
// so it gets direct test coverage proving it never disagrees with
// platformFeeCents() -- the SAME function that decides the real
// application_fee_amount at checkout and the real per-purchase earnings
// shown on Dashboard Sales (see src/lib/pricing.ts and
// src/lib/earnings-calculator.ts's own comment for why reusing it,
// rather than reimplementing the 20% split here, is load-bearing).
export function resolveWizardPriceSummary(price: string): WizardPriceSummary {
  // ALL-CATALOG-2: parses through the shared catalog domain instead of
  // a bare Number() * 100, so the earnings preview can never be
  // computed from a price the author will not actually be allowed to
  // save. priceCents is, and always was, minor units -- what changes is
  // that they are now hundredths of a lek rather than US cents.
  const parsed = parseCatalogPriceAll(price);
  const priceValid = parsed.ok;
  const priceCents = parsed.ok ? catalogPriceAllToMinor(parsed.priceAll) : 0;
  const isFreeBook = priceValid && priceCents === 0;
  const feeCents = isFreeBook ? 0 : platformFeeCents(priceCents);
  const earningsCents = isFreeBook ? 0 : priceCents - feeCents;

  return { priceValid, isFreeBook, priceCents, feeCents, earningsCents };
}
