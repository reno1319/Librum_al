// BD2 (Renato 11-01, answers 1a 2a 4a 5a): the author's royalty
// ("honorar", glossary T13) as the site DESCRIBES it -- decided 28 Oct
// (D2: 70/30; D3: 99 lek minimum, 50% below 199 lek, 70% from 199 lek,
// on the price the reader actually pays after any discount code; for a
// bundle, the bundle's price decides).
//
// DISPLAY ONLY, ON PURPOSE (answer 1a). Every public sentence and every
// earnings estimate (the /fitimet calculator, the book price step) reads
// from here. The real money -- checkout's frozen royalty_rate_bps and
// the ledger -- still runs on PLATFORM_FEE_PERCENT in src/lib/pricing.ts
// and the 8000 bps written into the database, until the live POK build
// (Master List N6) points them at these same tiers. Buying is off until
// that build, so no real sale can be paid at the old rate. Until then a
// test sale on staging shows 80% on Sales and Balance; that is expected.
//
// Rounding: every catalog price is whole lek (100 minor units each), so
// 70% or 50% of it is always a whole number of minor units. A discounted
// amount may not be, so Librum's share is rounded half away from zero
// (Math.round on a positive number, the same as PostgreSQL's numeric
// round()) and the author's share is the REMAINDER, never a second
// rounding: the two always sum to the price paid.

/** From this price (in lek, after any discount) the author gets the standard royalty. */
export const STANDARD_ROYALTY_FROM_ALL = 199;

/** The author's royalty from STANDARD_ROYALTY_FROM_ALL up. */
export const STANDARD_ROYALTY_PERCENT = 70;

/** The author's royalty below STANDARD_ROYALTY_FROM_ALL. */
export const REDUCED_ROYALTY_PERCENT = 50;

const MINOR_UNITS_PER_LEK = 100;

/**
 * The author's royalty percent for one sale, from the amount the reader
 * actually pays, in ALL minor units. A bundle passes the bundle's price.
 */
export function royaltyPercentForPaidMinor(paidMinor: number): number {
  return paidMinor >= STANDARD_ROYALTY_FROM_ALL * MINOR_UNITS_PER_LEK
    ? STANDARD_ROYALTY_PERCENT
    : REDUCED_ROYALTY_PERCENT;
}

/** Librum's share of one sale, in the same minor units it is given. */
export function librumShareMinor(paidMinor: number): number {
  const librumPercent = 100 - royaltyPercentForPaidMinor(paidMinor);
  return Math.round((paidMinor * librumPercent) / 100);
}

// The Albanian sentences every page shares, so the rule is written in
// one place. Built from the constants above, never from typed numbers.
const STD = `${STANDARD_ROYALTY_PERCENT}%`;
const RED = `${REDUCED_ROYALTY_PERCENT}%`;
const FROM = `${STANDARD_ROYALTY_FROM_ALL} lekë`;

/** Under the big "70%" (Renato's 4a). */
export const ROYALTY_HEADLINE_CAPTION = `për libra nga ${FROM}; ${RED} nën ${FROM}`;

/** One line: the rule, for the calculator and the price step. */
export const ROYALTY_TIERS_LINE = `Honorari i autorit: ${STD} e çmimit që paguan lexuesi, nga ${FROM} e lart; ${RED} nën ${FROM}.`;

/** The full rule, with "seller + royalty" (Renato's 2a). */
export const ROYALTY_RULE_SENTENCE = `Librum e shet librin tuaj dhe për çdo shitje ju paguan një honorar: ${STD} të çmimit që paguan lexuesi kur çmimi është ${FROM} ose më shumë, dhe ${RED} kur është nën ${FROM}.`;

/** What "the price the reader pays" means (D3; Renato's 5a for bundles). */
export const ROYALTY_PAID_PRICE_SENTENCE = `Vlen çmimi që paguhet realisht, pas çdo kodi zbritjeje; për një paketë vlen çmimi i paketës.`;

/** On the Discounts page (Renato's 6a). */
export const ROYALTY_DISCOUNT_NOTE = `Honorari llogaritet nga çmimi pas zbritjes: nëse një kod e çon çmimin nën ${FROM}, honorari juaj për atë shitje është ${RED} dhe jo ${STD}.`;
