import { platformFeeCents } from "@/lib/pricing";

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

export function canAdvanceFromPrice(params: { price: string }): boolean {
  if (params.price.trim().length === 0) return false;
  const value = Number(params.price);
  return Number.isFinite(value) && value >= 0;
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
  const priceNum = Number(price);
  const priceValid = Number.isFinite(priceNum) && priceNum >= 0;
  const priceCents = priceValid ? Math.round(priceNum * 100) : 0;
  const isFreeBook = priceValid && priceCents === 0;
  const feeCents = isFreeBook ? 0 : platformFeeCents(priceCents);
  const earningsCents = isFreeBook ? 0 : priceCents - feeCents;

  return { priceValid, isFreeBook, priceCents, feeCents, earningsCents };
}
