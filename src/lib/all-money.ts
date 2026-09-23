// ALL-WIRING-2: the single reader-facing formatter for an amount already
// expressed in ALL MINOR UNITS (100 minor units to one lek), as opposed
// to the WHOLE-ALL catalog integers `src/lib/catalog-price.ts` owns.
//
// Two different units, deliberately two different modules: a catalog
// price of `99` is ninety-nine lek, while a transaction amount of `9900`
// is the same money counted in minor units. Mixing the two is the exact
// class of mistake that produces a 100x charge, so nothing here accepts
// or returns a whole-ALL value and nothing in catalog-price.ts accepts a
// minor-unit one.
//
// Integer-only, by construction:
//
//   * no `Intl.NumberFormat`. `Intl.NumberFormat(..., {style:"currency",
//     currency:"ALL"})` resolves to minimumFractionDigits 0 under this
//     runtime's CLDR data -- `format(179.10)` yields `"ALL 179"`, which
//     silently drops the qindarka. That is a confirmed, previously
//     diagnosed bug in this codebase, not a hypothetical one.
//   * no division and no floating-point step of any kind. The minor and
//     whole parts are taken as SLICES of the integer's own decimal
//     digit string, so nothing here can round, drift, or depend on
//     whether `n / 100` happens to be exactly representable.
//   * no persistent decimal representation. The only decimal that ever
//     exists is the returned display string.
//
// Albanian convention, the same one `formatCatalogPriceAll` already
// uses: comma as the decimal separator, dot as the thousands separator,
// always exactly two displayed decimals, an explicit `ALL` suffix rather
// than a symbol so it can never be read as a dollar amount.
//
//   0        -> "Free"
//   9900     -> "99,00 ALL"
//   17910    -> "179,10 ALL"
//   10000000 -> "100.000,00 ALL"

/** Reader-facing label for a zero amount -- never "0,00 ALL". */
export const ALL_FREE_LABEL = "Free";

// Fixed, non-sensitive message: never echoes the offending value back.
const INVALID_MINOR_MESSAGE =
  "all-money: amount is not a non-negative integer number of ALL minor units";

/**
 * Formats a non-negative integer number of ALL minor units.
 *
 * Throws for anything that is not a non-negative safe integer --
 * including `-0`, which `Number.isSafeInteger` and `>= 0` both accept
 * and only `Object.is` can tell apart from `0`. A caller must never be
 * able to get a plausible-looking price string out of a value that was
 * never a real amount; the same posture `catalog-price.ts` takes for
 * its own domain.
 */
export function formatAllMinorUnits(minor: number): string {
  if (!Number.isSafeInteger(minor) || minor < 0 || Object.is(minor, -0)) {
    throw new Error(INVALID_MINOR_MESSAGE);
  }

  if (minor === 0) return ALL_FREE_LABEL;

  // String slicing, never arithmetic: `String(minor)` on a non-negative
  // safe integer is its exact decimal expansion, so padding it to at
  // least three digits makes the last two the minor part and everything
  // before them the whole part, for every value in the domain.
  const digits = String(minor).padStart(3, "0");
  const wholeDigits = digits.slice(0, -2);
  const minorDigits = digits.slice(-2);
  const grouped = wholeDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  return `${grouped},${minorDigits} ALL`;
}
