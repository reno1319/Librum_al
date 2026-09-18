// ALL-CATALOG-1 (foundation patch): pure, unwired primitives for Librum's
// whole-lek ALL catalog price model. Confirmed by the platform owner:
// Librum's catalog and checkout currency is ALL only -- authors set
// prices in whole ALL, readers pay in ALL, POK is the only provider for
// new paid checkouts. A catalog value of `99` means exactly 99 ALL --
// never 0.99 ALL, never 9,900 ALL. The valid paid range is 99 through
// 100,000 ALL inclusive; there is no supported USD catalog mode, past or
// future: this module has no USD-shaped input, output, or code path of
// any kind.
//
// This module is deliberately NOT wired into any form, action, RPC,
// provider adapter, or database code yet -- see the ALL-CATALOG-1 design
// report for the phased rollout that eventually connects it. It exists
// today only so the parsing/validation/formatting rules can be agreed and
// tested in isolation, ahead of any schema or UI change.
//
// Deliberately separate from src/lib/pricing.ts: that module's
// `price_cents`/`formatPrice`/`formatAllPrice` are minor-unit (÷100)
// helpers that exist for the CURRENT repository's legacy USD/Stripe code
// and its dormant ledger_v1 bridge. This module never reads, writes,
// scales, or reinterprets `price_cents` in any way -- it is a wholly
// independent whole-ALL representation, not a conversion of the legacy
// one. Existing `price_cents` values are addressed only by later,
// separately reviewed migration/wiring patches, never by this one.
//
// No network, database, Storage, provider, ledger, or environment-
// variable access of any kind -- see catalog-price.test.ts's own
// "performs no side effects" suite for the enforced guarantee (kept as
// supplemental evidence there, not the primary proof of purity -- the
// primary evidence is this file's own import list, below, being empty).

/** The Librum-owner-confirmed minimum price for a paid ALL catalog book. */
export const MINIMUM_PAID_CATALOG_PRICE_ALL = 99;

/** The Librum-owner-confirmed maximum price for any ALL catalog book. */
export const MAXIMUM_CATALOG_PRICE_ALL = 100_000;

/**
 * Result of parsing an author's raw catalog-price input. `ok: false`
 * carries no partial value on purpose -- a caller must never treat a
 * failed parse as "zero" or otherwise usable, which is exactly the kind
 * of silent reinterpretation this module exists to prevent.
 */
export type ParsedCatalogPrice = { ok: true; priceAll: number } | { ok: false };

// A defensive upper bound on the TRIMMED input's length, checked before
// the regex or any numeric conversion ever runs. Applied after trimming
// (never before -- surrounding whitespace must never itself cause a
// rejection that the same value, trimmed, would have passed). No
// legitimate whole-lek author price needs more than a handful of digits
// -- MAXIMUM_CATALOG_PRICE_ALL itself is 6 digits, and even a heavily
// zero-prefixed but otherwise valid input (e.g. "000000000099") has no
// legitimate reason to run past this -- so an arbitrarily long trimmed
// input (e.g. a deliberately huge zero-padded or garbage payload) is
// rejected outright, before the regex engine or Number() ever sees it.
const MAX_TRIMMED_INPUT_LENGTH = 32;

const WHOLE_ALL_INPUT = /^(\d+)(?:[.,](\d{2}))?$/;

/**
 * The single canonical numeric domain shared by parsing, classification,
 * and formatting -- exactly POSITIVE zero (free), or a safe integer from
 * MINIMUM_PAID_CATALOG_PRICE_ALL (99) through MAXIMUM_CATALOG_PRICE_ALL
 * (100,000) inclusive (paid). Nothing else is a valid catalog price at
 * any stage of this module -- there is deliberately only one place this
 * range is expressed, so parsing can never accept a value that
 * classification/formatting would then refuse, or vice versa.
 *
 * Numeric `-0` is explicitly excluded, even though `Number.isSafeInteger
 * (-0)` and `-0 === 0` are both `true` in JavaScript -- `Object.is`,
 * never `===`, is what can actually tell `-0` apart from `0`. The
 * string parser already rejects `"-0"`/`"-0,00"` by grammar (its regex
 * has no minus sign at all), but a caller passing the JS numeric literal
 * `-0` directly to classify/format bypasses that grammar entirely, so
 * the domain check itself must also refuse it.
 */
function isValidCatalogPriceAll(value: number): boolean {
  if (!Number.isSafeInteger(value)) return false;
  if (Object.is(value, -0)) return false;
  if (value === 0) return true;
  return value >= MINIMUM_PAID_CATALOG_PRICE_ALL && value <= MAXIMUM_CATALOG_PRICE_ALL;
}

// Fixed, non-sensitive message -- never includes the raw invalid value
// (or anything else caller-supplied) in the thrown error, so a bad input
// can never be echoed back through an exception message.
const INVALID_DOMAIN_MESSAGE =
  "catalog-price: value is not a valid whole-ALL catalog price (must be exactly 0, or a whole number from 99 through 100000)";

function assertValidCatalogPriceAll(value: number): void {
  if (!isValidCatalogPriceAll(value)) {
    throw new Error(INVALID_DOMAIN_MESSAGE);
  }
}

/**
 * Strictly parses an author-typed catalog price into a whole-ALL integer.
 * String-based: never runs the raw input through `Number()`/`parseFloat`
 * as a whole, so no binary-floating-point step exists between what the
 * author typed and the integer this returns.
 *
 * Order of operations (load-bearing -- see the module's own review
 * history for why): (1) confirm the input is a string; (2) trim
 * surrounding whitespace; (3) reject an empty trimmed result; (4) apply
 * the defensive length limit to the TRIMMED value, never the raw one;
 * (5) parse and validate the trimmed value's shape and numeric domain.
 * Surrounding whitespace can never by itself cause a rejection that the
 * same value, trimmed, would have passed.
 *
 * Accepts: `"0"`, `"0,00"`, `"0.00"` (free) and `"99"`, `"99,00"`,
 * `"99.00"`, `"250"`, ... up to `"100000"` (paid) -- always with an
 * all-zero two-digit decimal part when one is present, since a
 * whole-lek catalog price has no fractional component at all. Leading
 * zeros are accepted and normalized: `"099"` and `"00099"` both parse to
 * 99; `"00"`/`"000,00"` parse to the free price 0. Grouping separators
 * are never inferred from this -- `"1.000"` is not "one thousand", it is
 * rejected outright (a decimal point followed by three digits does not
 * match the required exactly-two-digit decimal shape).
 *
 * Rejects: empty/whitespace-only input, an excessively long trimmed
 * input, any nonzero decimal part (e.g. `"98,99"`, `"99.50"`,
 * `"00099,01"`), a nonzero paid amount below the 99 ALL floor (`"1"`..
 * `"98"`) or above the 100,000 ALL ceiling (`"100001"` and beyond,
 * including zero-prefixed forms of it), negative values (including
 * `"-0"`), a leading `+` sign, exponent notation, grouping separators
 * (`"1,234"`, `"1.234,56"`, `"1.000"`), any non-decimal-digit character,
 * an integer part unsafe for exact integer arithmetic, and any input
 * that isn't a string at all (a defensive guard for callers passing a
 * raw `FormData` value, which can be a `File`, or any other unexpected
 * type).
 */
export function parseCatalogPriceAll(input: unknown): ParsedCatalogPrice {
  if (typeof input !== "string") return { ok: false };

  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false };
  if (trimmed.length > MAX_TRIMMED_INPUT_LENGTH) return { ok: false };

  const match = WHOLE_ALL_INPUT.exec(trimmed);
  if (!match) return { ok: false };

  const [, wholeDigits, decimalDigits] = match;
  // A whole-lek catalog price has no fractional component -- a present
  // decimal part must be exactly "00", never merely two digits.
  if (decimalDigits !== undefined && decimalDigits !== "00") return { ok: false };

  // Number() on a pure-digit string (leading zeros included) is exact,
  // ordinary decimal parsing -- never octal, never scientific notation --
  // so this is the normalization step for leading zeros, not a separate
  // one: "00099" and "99" both become the same JS number 99.
  const priceAll = Number(wholeDigits);
  if (!isValidCatalogPriceAll(priceAll)) return { ok: false };

  return { ok: true, priceAll };
}

/**
 * Classifies an already-validated whole-ALL catalog price. Enforces the
 * same canonical numeric domain `parseCatalogPriceAll` does (via
 * `assertValidCatalogPriceAll`) -- it does NOT trust a comment-only
 * "caller already validated this" contract, so a value outside the
 * domain (e.g. 1, 98, 100001, a negative, a fraction, NaN, Infinity, an
 * unsafe integer) throws rather than silently classifying.
 */
export function classifyCatalogPrice(priceAll: number): "free" | "paid" {
  assertValidCatalogPriceAll(priceAll);
  return priceAll === 0 ? "free" : "paid";
}

/**
 * Albanian reader-facing display for a validated whole-ALL catalog
 * price -- the owner-confirmed convention is comma as the decimal
 * separator, dot as the thousands separator, always exactly two display
 * decimals: `99` -> `"99,00 ALL"`, `1000` -> `"1.000,00 ALL"`,
 * `100000` -> `"100.000,00 ALL"`. Enforces the same canonical numeric
 * domain `parseCatalogPriceAll`/`classifyCatalogPrice` do -- a value
 * outside the domain throws rather than silently formatting (e.g.
 * `formatCatalogPriceAll(1)` throws; it never again returns
 * `"1,00 ALL"` for a value that was never a valid catalog price in the
 * first place). Every catalog price is whole lek by construction, so
 * the displayed fractional part is always the literal `"00"` -- this
 * never performs (or needs) qindarka-level arithmetic.
 *
 * Grouping is implemented with plain digit-string manipulation, not
 * `Intl.NumberFormat` -- deliberately, so this never depends on the
 * runtime's bundled CLDR/ICU data (the exact class of dependency that
 * already caused a real, previously-diagnosed display bug elsewhere in
 * this codebase: `Intl.NumberFormat(..., {style:"currency",
 * currency:"ALL"})` rounded off ALL's minor units under this runtime's
 * default CLDR data). Pure string manipulation over an already-validated
 * safe integer produces byte-identical output in every server and
 * browser environment.
 */
export function formatCatalogPriceAll(priceAll: number): string {
  assertValidCatalogPriceAll(priceAll);
  return formatAllMinorUnits(catalogPriceAllToMinor(priceAll));
}

// ============================================================
// ALL-CATALOG-2 (wiring patch): the minor-unit boundary.
//
// Everything this module exposed before this point speaks WHOLE lek --
// the unit an author types and a reader reads. Everything Librum
// STORES speaks hundredths of a lek: books.price_cents,
// book_checkout_intents.price_cents_at_checkout, payments.amount_minor
// and the whole author_ledger_entries chain are minor-unit columns, and
// src/lib/pok-checkout.ts converts back to POK's major units with a
// single `/ 100` at the provider boundary (see POK_STAGING.md: "POK
// major-unit amounts are converted to/from internal hundredths
// exactly").
//
// The two converters below are the ONLY sanctioned crossing between
// those units. They live here, beside the domain they validate, rather
// than as a bare `* 100` scattered across four Server Actions and two
// forms -- a stray multiplication at a call site is exactly how a
// catalog price silently becomes a hundredfold error.
// ============================================================

/** Hundredths of a lek per whole lek. ALL's own minor-unit convention. */
export const CATALOG_MINOR_UNITS_PER_ALL = 100;

/** `MINIMUM_PAID_CATALOG_PRICE_ALL` expressed in stored minor units. */
export const MINIMUM_PAID_CATALOG_PRICE_MINOR =
  MINIMUM_PAID_CATALOG_PRICE_ALL * CATALOG_MINOR_UNITS_PER_ALL;

/** `MAXIMUM_CATALOG_PRICE_ALL` expressed in stored minor units. */
export const MAXIMUM_CATALOG_PRICE_MINOR =
  MAXIMUM_CATALOG_PRICE_ALL * CATALOG_MINOR_UNITS_PER_ALL;

/**
 * Whole-lek catalog price -> the minor-unit integer Librum stores.
 * Enforces the same canonical domain every other function here does, so
 * an out-of-domain value can never be written to the database through
 * this path.
 */
export function catalogPriceAllToMinor(priceAll: number): number {
  assertValidCatalogPriceAll(priceAll);
  return priceAll * CATALOG_MINOR_UNITS_PER_ALL;
}

/**
 * Stored minor units -> whole-lek catalog price. Throws for a value
 * that is not a whole number of lek (a legacy row priced under the old
 * USD-cents assumption, e.g. 999, is NOT a valid catalog price and must
 * never be silently reinterpreted as one) or outside the catalog
 * domain. Callers that merely DISPLAY an arbitrary stored amount want
 * `formatAllMinorUnits` below instead -- display must never throw.
 */
export function minorToCatalogPriceAll(priceMinorUnits: number): number {
  if (
    !Number.isSafeInteger(priceMinorUnits) ||
    priceMinorUnits % CATALOG_MINOR_UNITS_PER_ALL !== 0
  ) {
    throw new Error(INVALID_DOMAIN_MESSAGE);
  }
  const priceAll = priceMinorUnits / CATALOG_MINOR_UNITS_PER_ALL;
  assertValidCatalogPriceAll(priceAll);
  return priceAll;
}

/**
 * LENIENT display formatter for any stored minor-unit amount, in the
 * same Albanian convention `formatCatalogPriceAll` uses (dot groups
 * thousands, comma separates the decimals, explicit "ALL" suffix).
 *
 * Deliberately does NOT enforce the catalog domain, and deliberately
 * does not throw. It renders amounts that are legitimately not catalog
 * prices: a past purchase, a refund amount, an author's accrued
 * balance, a platform fee, and -- until the catalog is re-priced -- a
 * legacy row still holding a USD-cents value. A formatter that throws
 * takes a whole page down with it; validation belongs on input, which
 * is what `parseCatalogPriceAll` and `catalogPriceAllToMinor` are for.
 *
 * A negative amount keeps its sign ahead of the digits (-1.234,50 ALL),
 * since ledger and refund surfaces legitimately show one. A non-finite
 * or non-integer input renders as the literal "— ALL" rather than
 * "NaN ALL".
 */
export function formatAllMinorUnits(priceMinorUnits: number): string {
  if (!Number.isSafeInteger(priceMinorUnits)) return "— ALL";

  const negative = priceMinorUnits < 0;
  const absolute = Math.abs(priceMinorUnits);
  const whole = Math.trunc(absolute / CATALOG_MINOR_UNITS_PER_ALL);
  const fraction = absolute % CATALOG_MINOR_UNITS_PER_ALL;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ".");

  return `${negative ? "-" : ""}${grouped},${String(fraction).padStart(2, "0")} ALL`;
}

/**
 * The value a price `<input>` should be pre-filled with for a stored
 * amount: the whole-lek number as a bare string, or "" when the stored
 * value is not a valid whole-lek catalog price.
 *
 * The empty string is the load-bearing case. Every book priced before
 * ALL-CATALOG-2 holds a USD-cents value (999 meaning "$9.99"), which is
 * 9.99 lek -- not a catalog price at all. Pre-filling "9.99" would
 * invite the author to press Save on a number that means something
 * different from what they originally chose, and pre-filling "999"
 * would silently hundredfold it. Blank forces a deliberate re-entry,
 * which is the only honest option: nothing in the database records
 * which currency the original number was typed in.
 */
export function catalogPriceInputValue(priceMinorUnits: number): string {
  try {
    return String(minorToCatalogPriceAll(priceMinorUnits));
  } catch {
    return "";
  }
}
