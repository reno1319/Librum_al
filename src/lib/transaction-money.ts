// ALL-TXN-CURRENCY-4 (Patch 4): the single formatter for a TRANSACTION
// amount -- a purchase, bundle charge, refund, dispute, ledger entry,
// balance or payout -- together with the currency that transaction was
// actually charged or booked in.
//
// Three rules this module exists to make impossible to break by accident:
//
//   1. A stored amount never identifies its own currency. Every entry
//      point here takes the currency EXPLICITLY, and there is no default:
//      no parameter falls back to USD, and nothing assumes ALL merely
//      because the ALL cutover has happened.
//   2. Transaction amounts are integer MINOR units (100 per lek, 100
//      cents per dollar). The catalog's whole-ALL integers live in
//      src/lib/catalog-price.ts and are deliberately never accepted
//      here -- a whole-lek value formatted as minor units is a 100x
//      error.
//   3. No floating point. The whole and minor parts are slices of the
//      integer's own decimal digit string, the same technique
//      src/lib/all-money.ts uses, so nothing can round or drift. No
//      `Intl.NumberFormat` either: under this runtime's CLDR data it gives
//      ALL zero fraction digits and silently drops the qindarka, and its
//      output depends on the server locale.
//
// One visible convention, locale-independent and always naming the
// currency (never a bare `$`):
//
//   ALL  ->  "1.234,56 ALL"   "-1.234,56 ALL"   "0,00 ALL"
//   USD  ->  "USD 1,234.56"   "-USD 1,234.56"   "USD 0.00"

export const SUPPORTED_TRANSACTION_CURRENCIES = ["ALL", "USD"] as const;

export type TransactionCurrency = (typeof SUPPORTED_TRANSACTION_CURRENCIES)[number];

export function isSupportedTransactionCurrency(value: unknown): value is TransactionCurrency {
  return (
    typeof value === "string" &&
    (SUPPORTED_TRANSACTION_CURRENCIES as readonly string[]).includes(value)
  );
}

// Fixed, non-sensitive messages: never echo the offending value back.
const INVALID_AMOUNT_MESSAGE =
  "transaction-money: amount is not a safe integer number of minor units";
const INVALID_CURRENCY_MESSAGE =
  "transaction-money: currency is not a supported transaction currency";

function assertMinorUnits(amountMinor: unknown): asserts amountMinor is number {
  if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor)) {
    throw new Error(INVALID_AMOUNT_MESSAGE);
  }
}

function splitDigits(absoluteMinor: number): { whole: string; minor: string } {
  const digits = String(absoluteMinor).padStart(3, "0");
  return { whole: digits.slice(0, -2), minor: digits.slice(-2) };
}

function groupThousands(wholeDigits: string, separator: string): string {
  return wholeDigits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/**
 * Formats an integer number of minor units in an explicitly supplied,
 * supported currency. Throws for a non-integer, unsafe, non-numeric
 * amount, and for any currency other than ALL or USD -- a caller must
 * never obtain a plausible money string from a value that was never a
 * real amount, nor from a currency this module cannot render correctly.
 *
 * Negative amounts (ledger refunds, adjustments, negative balances) keep
 * their sign; `-0` renders as zero.
 */
export function formatTransactionMinorUnits(
  amountMinor: number,
  currency: TransactionCurrency,
): string {
  assertMinorUnits(amountMinor);
  if (!isSupportedTransactionCurrency(currency)) {
    throw new Error(INVALID_CURRENCY_MESSAGE);
  }

  const negative = amountMinor < 0;
  // Math.abs of a safe integer is a safe integer; no fractional step.
  const { whole, minor } = splitDigits(Math.abs(amountMinor));
  const sign = negative ? "-" : "";

  if (currency === "ALL") {
    return `${sign}${groupThousands(whole, ".")},${minor} ALL`;
  }
  return `${sign}USD ${groupThousands(whole, ",")}.${minor}`;
}

// ---------------------------------------------------------------------
// Currency provenance: what is actually KNOWN about a row's currency.
//
// Mirrors the currency_state/currency pair the
// transaction_currency_provenance() family of database functions returns
// (migration 20260923160231). Only 'resolved' carries a currency; every
// other state is displayed as an explicit "unavailable" label rather than
// as a number, because a number shown without its real currency is the
// exact misreading this patch exists to remove.
// ---------------------------------------------------------------------

export type CurrencyProvenance =
  | { state: "resolved"; currency: TransactionCurrency }
  // Authoritatively recorded, but not a currency this app can render.
  | { state: "unsupported"; currency: string }
  // A free acquisition: no transaction, so no currency at all.
  | { state: "free" }
  // No authoritative evidence exists. Never defaulted.
  | { state: "unknown" }
  // Authoritative records disagree. Never resolved by picking one.
  | { state: "conflict" };

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

function fromCurrencyCode(currency: unknown): CurrencyProvenance {
  if (isSupportedTransactionCurrency(currency)) {
    return { state: "resolved", currency };
  }
  if (typeof currency === "string" && CURRENCY_CODE_PATTERN.test(currency)) {
    return { state: "unsupported", currency };
  }
  return { state: "unknown" };
}

/**
 * Reads a (currency_state, currency) pair as returned by the provenance
 * RPCs. Anything missing, malformed or self-contradictory -- including a
 * row the RPC did not return at all (both arguments undefined) -- is
 * 'unknown', never a guessed currency.
 */
export function parseCurrencyProvenance(state: unknown, currency: unknown): CurrencyProvenance {
  switch (state) {
    case "resolved":
      return fromCurrencyCode(currency);
    case "free":
      return currency === null || currency === undefined ? { state: "free" } : { state: "unknown" };
    case "conflict":
      return { state: "conflict" };
    default:
      return { state: "unknown" };
  }
}

/**
 * For a row whose OWN column is the authoritative currency: the ledger
 * (author_ledger_entries/author_balances/author_payouts, surfaced through
 * the author financial RPCs), and the immutable checkout facts
 * (book_checkout_intents.currency, bundle_checkout_snapshots.currency).
 */
export function provenanceFromStoredCurrency(currency: unknown): CurrencyProvenance {
  return fromCurrencyCode(currency);
}

export const CURRENCY_UNKNOWN_LABEL = "Amount unavailable (currency unknown)";
export const CURRENCY_CONFLICT_LABEL = "Amount unavailable (conflicting currency records)";
export const INVALID_AMOUNT_LABEL = "Amount unavailable (invalid amount)";
export const FREE_ACQUISITION_LABEL = "Free";

export function unsupportedCurrencyLabel(currency: string): string {
  return `Amount unavailable (unsupported currency ${currency})`;
}

/**
 * The display string for one transaction amount. Never throws: a single
 * malformed row renders an explicit "unavailable" label instead of taking
 * down the whole page, and never renders a bare number.
 */
export function formatTransactionAmount(amountMinor: number, provenance: CurrencyProvenance): string {
  switch (provenance.state) {
    case "resolved":
      if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor)) {
        return INVALID_AMOUNT_LABEL;
      }
      return formatTransactionMinorUnits(amountMinor, provenance.currency);
    case "free":
      // A free acquisition moved no money; a non-zero amount on one is
      // inconsistent, and is shown as such rather than given a currency.
      return amountMinor === 0 ? FREE_ACQUISITION_LABEL : CURRENCY_UNKNOWN_LABEL;
    case "unsupported":
      return unsupportedCurrencyLabel(provenance.currency);
    case "conflict":
      return CURRENCY_CONFLICT_LABEL;
    default:
      return CURRENCY_UNKNOWN_LABEL;
  }
}

/**
 * Combines the provenances of rows that belong to ONE transaction (e.g.
 * a bundle's purchases rows plus its snapshot). Two different resolved
 * currencies, or any conflict, is a conflict; free rows carry no
 * currency and never outvote a real one.
 */
export function mergeCurrencyProvenances(provenances: CurrencyProvenance[]): CurrencyProvenance {
  const codes = new Set<string>();
  let sawUnknown = false;
  let sawFree = false;

  for (const provenance of provenances) {
    switch (provenance.state) {
      case "conflict":
        return { state: "conflict" };
      case "resolved":
      case "unsupported":
        codes.add(provenance.currency);
        break;
      case "free":
        sawFree = true;
        break;
      default:
        sawUnknown = true;
    }
  }

  if (codes.size > 1) return { state: "conflict" };
  if (codes.size === 1) {
    // A known currency next to rows with NO evidence is not a
    // contradiction -- but it is not full agreement either, so the
    // transaction is only as known as its least-known row.
    if (sawUnknown) return { state: "unknown" };
    return fromCurrencyCode([...codes][0]);
  }
  if (sawUnknown) return { state: "unknown" };
  return sawFree ? { state: "free" } : { state: "unknown" };
}

export type CurrencyTotal = { currency: TransactionCurrency; amountMinor: number };

export type CurrencyTotals = {
  // One entry per currency actually present, ordered by currency code so
  // the output is deterministic. Never a cross-currency total.
  totals: CurrencyTotal[];
  // Rows with a non-zero amount that could not be attributed to a
  // supported currency. Reported, never summed.
  unresolvedCount: number;
};

/**
 * Sums amounts PER CURRENCY. Rows are never added across currencies,
 * never converted, and a row without a resolved currency is counted
 * separately rather than folded into any total. Free rows (always zero)
 * contribute nothing.
 */
export function sumMinorUnitsByCurrency(
  entries: { amountMinor: number; provenance: CurrencyProvenance }[],
): CurrencyTotals {
  const byCurrency = new Map<TransactionCurrency, number>();
  let unresolvedCount = 0;

  for (const entry of entries) {
    if (entry.provenance.state === "free") continue;
    if (entry.provenance.state !== "resolved") {
      unresolvedCount += 1;
      continue;
    }
    assertMinorUnits(entry.amountMinor);
    const next = (byCurrency.get(entry.provenance.currency) ?? 0) + entry.amountMinor;
    if (!Number.isSafeInteger(next)) {
      throw new Error(INVALID_AMOUNT_MESSAGE);
    }
    byCurrency.set(entry.provenance.currency, next);
  }

  const totals = [...byCurrency.entries()]
    .map(([currency, amountMinor]) => ({ currency, amountMinor }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));

  return { totals, unresolvedCount };
}
