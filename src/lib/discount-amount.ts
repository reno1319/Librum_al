// ALL-DISCOUNT-3 (Patch 3 of the ALL application-wiring sequence): pure
// primitives for an author's FIXED discount in whole ALL, and the one
// honest display of every discount-code shape the table can hold.
//
// A fixed discount of `250` means exactly 250 ALL off -- never 2.50 ALL,
// never 25,000 ALL. It is stored in `discount_codes.amount_off_all`,
// whose CHECK constraint (`discount_codes_amount_off_all_range_check`)
// admits 1 through 100,000 inclusive; this module's domain is that
// constraint, restated, and nothing else.
//
// Deliberately SEPARATE from src/lib/catalog-price.ts, although the
// input grammar is the same owner-confirmed whole-lek convention. The
// two domains differ in exactly the way that matters: a catalog price
// has a 99 ALL paid floor and a free state of 0, while a discount has
// neither -- 1 ALL off is a legal discount, and 0 ALL off is not a
// discount at all. Sharing one parser would put the catalog floor on
// discounts, or take it off prices. Whether a given code leaves a legal
// price for a given book is decided at checkout
// (`create_book_checkout_intent` rejects with `discount_below_minimum`),
// never here: this module does not know what book a code is for.
//
// The legacy `discount_codes.amount_off_cents` column is USD minor
// units from the Stripe era. Nothing here parses, produces, scales or
// converts it; `describeDiscountCode` only LABELS such a row as legacy
// USD and inapplicable, and never prints its number as lek.
//
// No imports, so no network, database, provider or environment access.

/** Smallest fixed discount, in whole ALL (the column's CHECK lower bound). */
export const MINIMUM_FIXED_DISCOUNT_ALL = 1;

/** Largest fixed discount, in whole ALL (the column's CHECK upper bound). */
export const MAXIMUM_FIXED_DISCOUNT_ALL = 100_000;

/**
 * The discount form's `type` value for a FIXED discount in whole ALL.
 * Deliberately not the old `"amount"`, which meant USD: a stale form
 * posting `"amount"` is refused as an unknown type rather than having
 * its dollar figure stored as lek.
 */
export const FIXED_ALL_DISCOUNT_FORM_TYPE = "amount_all";

/**
 * Result of parsing an author's raw fixed-discount input. A failure
 * carries no partial value, so a caller can never mistake it for zero.
 */
export type ParsedFixedDiscount = { ok: true; amountOffAll: number } | { ok: false };

// Checked on the TRIMMED input before the regex or any numeric step, so
// an oversized payload is refused without being scanned or converted.
// 100000 is six digits; a zero-padded "000000100000,00" is fifteen.
const MAX_TRIMMED_INPUT_LENGTH = 32;

// Digits only, optionally followed by a two-digit decimal part after a
// comma or a dot. No sign, no exponent, no grouping separator, no
// whitespace inside the value -- all of them fail this match.
const WHOLE_ALL_INPUT = /^(\d+)(?:[.,](\d{2}))?$/;

function isValidFixedDiscountAll(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MINIMUM_FIXED_DISCOUNT_ALL &&
    value <= MAXIMUM_FIXED_DISCOUNT_ALL
  );
}

// Fixed text: never echoes the offending value back through an error.
const INVALID_DOMAIN_MESSAGE =
  "discount-amount: value is not a valid fixed ALL discount (must be a whole number from 1 through 100000)";

/**
 * Strictly parses an author-typed fixed discount into a whole-ALL
 * integer. String-based: the raw input never passes through
 * `Number()`/`parseFloat` as a whole, so no binary floating-point step
 * sits between what the author typed and the stored integer. The only
 * `Number()` call converts a string that is already known to be pure
 * ASCII digits, which is exact.
 *
 * Accepts `"1"` through `"100000"`, surrounding whitespace, leading
 * zeros (`"0250"` is 250), and a decimal part only when it is exactly
 * zero (`"250,00"`, `"250.00"`) -- the same whole-lek input convention
 * the catalog price field uses.
 *
 * Rejects anything that is not a string (a `File` from `FormData`,
 * `null`, a number), empty or whitespace-only input, an oversized
 * input, `0` in any spelling, a nonzero or non-two-digit decimal part
 * (`"250,50"`, `"250.5"`, `"250.000"`), signs (`"+5"`, `"-5"`),
 * exponent notation (`"1e3"`), grouping separators (`"1.000"`,
 * `"1,000"`, `"1 000"`), non-ASCII digits, and any value above 100000.
 */
export function parseFixedDiscountAll(input: unknown): ParsedFixedDiscount {
  if (typeof input !== "string") return { ok: false };

  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false };
  if (trimmed.length > MAX_TRIMMED_INPUT_LENGTH) return { ok: false };

  const match = WHOLE_ALL_INPUT.exec(trimmed);
  if (!match) return { ok: false };

  const [, wholeDigits, decimalDigits] = match;
  if (decimalDigits !== undefined && decimalDigits !== "00") return { ok: false };

  const amountOffAll = Number(wholeDigits);
  if (!isValidFixedDiscountAll(amountOffAll)) return { ok: false };

  return { ok: true, amountOffAll };
}

function groupDigits(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Albanian display of a validated fixed ALL discount, in the same
 * convention as `formatCatalogPriceAll` (dot thousands, comma decimals,
 * explicit `ALL` suffix): `250` -> `"250,00 ALL"`, `1000` ->
 * `"1.000,00 ALL"`. Throws outside 1..100000 rather than formatting a
 * value that could never have been stored. Applies no catalog minimum:
 * `formatFixedDiscountAll(1)` is `"1,00 ALL"`.
 */
export function formatFixedDiscountAll(amountOffAll: number): string {
  if (!isValidFixedDiscountAll(amountOffAll)) throw new Error(INVALID_DOMAIN_MESSAGE);
  return `${groupDigits(String(amountOffAll), ".")},00 ALL`;
}

/** The three columns that decide what a discount code does. */
export type DiscountValueColumns = {
  percent_off: number | null;
  amount_off_cents: number | null;
  amount_off_all: number | null;
};

export type DiscountDisplay =
  | { kind: "percent"; label: string }
  | { kind: "fixed_all"; label: string }
  | { kind: "legacy_usd"; label: string; notice: string }
  | { kind: "unrecognized"; label: string };

/** Shown beside every legacy USD code. */
export const LEGACY_USD_DISCOUNT_NOTICE =
  "Legacy USD discount: not applicable to ALL checkout";

const UNRECOGNIZED_DISCOUNT_LABEL = "Unrecognized discount";

// USD minor units rendered by slicing the integer's own digits, so no
// division or float step can round the historical value.
function formatLegacyUsdCents(cents: number): string {
  const digits = String(cents).padStart(3, "0");
  const whole = digits.slice(0, -2);
  const minor = digits.slice(-2);
  return `USD ${groupDigits(whole, ",")}.${minor}`;
}

/**
 * The one display for a stored discount code. Total: it never throws,
 * because it renders rows read back from the database, and anything it
 * cannot vouch for becomes "Unrecognized discount" rather than a number.
 *
 *   percent_off      -> "10% off"
 *   amount_off_all   -> "250,00 ALL off" (no catalog minimum applied)
 *   amount_off_cents -> "USD 5.00 off" plus the legacy notice. The value
 *                       is shown in its own currency and never as lek.
 *
 * Exactly one of the three columns must be set, mirroring
 * `discount_codes_exactly_one_discount_type_check`; any other shape is
 * unrecognized rather than guessed at.
 */
export function describeDiscountCode(code: DiscountValueColumns): DiscountDisplay {
  const set = [code.percent_off, code.amount_off_cents, code.amount_off_all].filter(
    (value) => value !== null && value !== undefined,
  );
  if (set.length !== 1) return { kind: "unrecognized", label: UNRECOGNIZED_DISCOUNT_LABEL };

  const { percent_off, amount_off_cents, amount_off_all } = code;

  if (percent_off !== null && percent_off !== undefined) {
    if (!Number.isSafeInteger(percent_off) || percent_off < 1 || percent_off > 100) {
      return { kind: "unrecognized", label: UNRECOGNIZED_DISCOUNT_LABEL };
    }
    return { kind: "percent", label: `${percent_off}% off` };
  }

  if (amount_off_all !== null && amount_off_all !== undefined) {
    if (!isValidFixedDiscountAll(amount_off_all)) {
      return { kind: "unrecognized", label: UNRECOGNIZED_DISCOUNT_LABEL };
    }
    return { kind: "fixed_all", label: `${formatFixedDiscountAll(amount_off_all)} off` };
  }

  if (!Number.isSafeInteger(amount_off_cents) || (amount_off_cents as number) < 1) {
    return { kind: "unrecognized", label: UNRECOGNIZED_DISCOUNT_LABEL };
  }
  return {
    kind: "legacy_usd",
    label: `${formatLegacyUsdCents(amount_off_cents as number)} off`,
    notice: LEGACY_USD_DISCOUNT_NOTICE,
  };
}
