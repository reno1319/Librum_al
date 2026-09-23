import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CURRENCY_CONFLICT_LABEL,
  CURRENCY_UNKNOWN_LABEL,
  FREE_ACQUISITION_LABEL,
  INVALID_AMOUNT_LABEL,
  SUPPORTED_TRANSACTION_CURRENCIES,
  formatTransactionAmount,
  formatTransactionMinorUnits,
  isSupportedTransactionCurrency,
  mergeCurrencyProvenances,
  parseCurrencyProvenance,
  provenanceFromStoredCurrency,
  sumMinorUnitsByCurrency,
  type CurrencyProvenance,
  type TransactionCurrency,
} from "./transaction-money";

const ALL: CurrencyProvenance = { state: "resolved", currency: "ALL" };
const USD: CurrencyProvenance = { state: "resolved", currency: "USD" };

describe("formatTransactionMinorUnits: ALL (100 minor units per lek)", () => {
  it.each([
    [0, "0,00 ALL"],
    [1, "0,01 ALL"],
    [99, "0,99 ALL"],
    [100, "1,00 ALL"],
    [9900, "99,00 ALL"],
    [12345, "123,45 ALL"],
    [17910, "179,10 ALL"],
    [123456, "1.234,56 ALL"],
    [10000000, "100.000,00 ALL"],
    [123456789012, "1.234.567.890,12 ALL"],
  ])("%i -> %s", (minor, expected) => {
    expect(formatTransactionMinorUnits(minor, "ALL")).toBe(expected);
  });

  it.each([
    [-1, "-0,01 ALL"],
    [-99, "-0,99 ALL"],
    [-100, "-1,00 ALL"],
    [-12345, "-123,45 ALL"],
    [-123456, "-1.234,56 ALL"],
  ])("negative %i -> %s", (minor, expected) => {
    expect(formatTransactionMinorUnits(minor, "ALL")).toBe(expected);
  });
});

describe("formatTransactionMinorUnits: USD (100 cents per dollar)", () => {
  it.each([
    [0, "USD 0.00"],
    [1, "USD 0.01"],
    [99, "USD 0.99"],
    [100, "USD 1.00"],
    [12345, "USD 123.45"],
    [123456, "USD 1,234.56"],
    [10000000, "USD 100,000.00"],
  ])("%i -> %s", (minor, expected) => {
    expect(formatTransactionMinorUnits(minor, "USD")).toBe(expected);
  });

  it.each([
    [-1, "-USD 0.01"],
    [-99, "-USD 0.99"],
    [-100, "-USD 1.00"],
    [-12345, "-USD 123.45"],
  ])("negative %i -> %s", (minor, expected) => {
    expect(formatTransactionMinorUnits(minor, "USD")).toBe(expected);
  });

  it("never renders a bare dollar sign", () => {
    for (const minor of [0, 1, 99, 100, 12345, -12345]) {
      expect(formatTransactionMinorUnits(minor, "USD")).not.toContain("$");
    }
  });
});

describe("formatTransactionMinorUnits: the same amount never reads the same in two currencies", () => {
  it("relabelling ALL as USD (or back) always changes the output", () => {
    for (const minor of [0, 1, 99, 100, 12345, -12345]) {
      expect(formatTransactionMinorUnits(minor, "ALL")).not.toBe(formatTransactionMinorUnits(minor, "USD"));
    }
  });

  it("-0 renders as zero, not negative zero", () => {
    expect(formatTransactionMinorUnits(-0, "ALL")).toBe("0,00 ALL");
    expect(formatTransactionMinorUnits(-0, "USD")).toBe("USD 0.00");
  });

  it("the largest safe integer formats exactly, with no floating-point drift", () => {
    expect(formatTransactionMinorUnits(Number.MAX_SAFE_INTEGER, "ALL")).toBe("90.071.992.547.409,91 ALL");
    expect(formatTransactionMinorUnits(-Number.MAX_SAFE_INTEGER, "USD")).toBe("-USD 90,071,992,547,409.91");
  });
});

describe("formatTransactionMinorUnits: rejects anything that is not a real amount", () => {
  it.each([
    ["a fraction", 12.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 1],
    ["a numeric string", "100" as unknown as number],
    ["a bigint", BigInt(100) as unknown as number],
    ["null", null as unknown as number],
    ["undefined", undefined as unknown as number],
  ])("throws for %s", (_label, value) => {
    expect(() => formatTransactionMinorUnits(value, "ALL")).toThrow(/not a safe integer/);
    expect(() => formatTransactionMinorUnits(value, "USD")).toThrow(/not a safe integer/);
  });

  it("the error message never echoes the offending value", () => {
    expect(() => formatTransactionMinorUnits(12.345678, "ALL")).toThrow(
      "transaction-money: amount is not a safe integer number of minor units",
    );
  });
});

describe("formatTransactionMinorUnits: never guesses a currency", () => {
  it.each([
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["lower-case usd", "usd"],
    ["lower-case all", "all"],
    ["an unsupported code", "EUR"],
    ["a symbol", "$"],
  ])("throws for a %s currency", (_label, currency) => {
    expect(() => formatTransactionMinorUnits(100, currency as unknown as TransactionCurrency)).toThrow(
      /not a supported transaction currency/,
    );
  });

  it("supports exactly ALL and USD", () => {
    expect([...SUPPORTED_TRANSACTION_CURRENCIES]).toEqual(["ALL", "USD"]);
    expect(isSupportedTransactionCurrency("ALL")).toBe(true);
    expect(isSupportedTransactionCurrency("USD")).toBe(true);
    expect(isSupportedTransactionCurrency("EUR")).toBe(false);
    expect(isSupportedTransactionCurrency(undefined)).toBe(false);
  });

  it("has no default currency parameter", () => {
    // A defaulted parameter would make the one-argument call legal.
    expect(formatTransactionMinorUnits.length).toBe(2);
  });
});

describe("parseCurrencyProvenance", () => {
  it("reads a resolved supported currency", () => {
    expect(parseCurrencyProvenance("resolved", "ALL")).toEqual(ALL);
    expect(parseCurrencyProvenance("resolved", "USD")).toEqual(USD);
  });

  it("keeps a resolved but unsupported currency distinct, never mapping it to USD or ALL", () => {
    expect(parseCurrencyProvenance("resolved", "EUR")).toEqual({ state: "unsupported", currency: "EUR" });
  });

  it("treats a resolved row with a missing or malformed currency as unknown", () => {
    expect(parseCurrencyProvenance("resolved", null)).toEqual({ state: "unknown" });
    expect(parseCurrencyProvenance("resolved", "usd")).toEqual({ state: "unknown" });
    expect(parseCurrencyProvenance("resolved", "")).toEqual({ state: "unknown" });
  });

  it("reads free, conflict and unknown", () => {
    expect(parseCurrencyProvenance("free", null)).toEqual({ state: "free" });
    expect(parseCurrencyProvenance("conflict", null)).toEqual({ state: "conflict" });
    expect(parseCurrencyProvenance("unknown", null)).toEqual({ state: "unknown" });
  });

  it("a self-contradictory 'free' row that names a currency is unknown", () => {
    expect(parseCurrencyProvenance("free", "USD")).toEqual({ state: "unknown" });
  });

  it("a row the RPC never returned (both undefined) is unknown -- the missing-currency default is never USD", () => {
    expect(parseCurrencyProvenance(undefined, undefined)).toEqual({ state: "unknown" });
    expect(parseCurrencyProvenance("garbage", "USD")).toEqual({ state: "unknown" });
  });
});

describe("provenanceFromStoredCurrency", () => {
  it("maps a stored ledger/snapshot/intent currency", () => {
    expect(provenanceFromStoredCurrency("ALL")).toEqual(ALL);
    expect(provenanceFromStoredCurrency("USD")).toEqual(USD);
    expect(provenanceFromStoredCurrency("EUR")).toEqual({ state: "unsupported", currency: "EUR" });
    expect(provenanceFromStoredCurrency(null)).toEqual({ state: "unknown" });
    expect(provenanceFromStoredCurrency(undefined)).toEqual({ state: "unknown" });
  });
});

describe("formatTransactionAmount", () => {
  it("formats a resolved amount in its own currency", () => {
    expect(formatTransactionAmount(17910, ALL)).toBe("179,10 ALL");
    expect(formatTransactionAmount(999, USD)).toBe("USD 9.99");
  });

  it("never renders a number for an unresolved currency", () => {
    expect(formatTransactionAmount(999, { state: "unknown" })).toBe(CURRENCY_UNKNOWN_LABEL);
    expect(formatTransactionAmount(999, { state: "conflict" })).toBe(CURRENCY_CONFLICT_LABEL);
    expect(formatTransactionAmount(999, { state: "unsupported", currency: "EUR" })).toBe(
      "Amount unavailable (unsupported currency EUR)",
    );
    for (const label of [
      formatTransactionAmount(999, { state: "unknown" }),
      formatTransactionAmount(999, { state: "conflict" }),
      formatTransactionAmount(999, { state: "unsupported", currency: "EUR" }),
    ]) {
      expect(label).not.toMatch(/9[.,]99/);
      expect(label).not.toContain("$");
      expect(label).not.toContain("USD");
    }
  });

  it("a free acquisition reads Free; a non-zero 'free' row is inconsistent and unavailable", () => {
    expect(formatTransactionAmount(0, { state: "free" })).toBe(FREE_ACQUISITION_LABEL);
    expect(formatTransactionAmount(500, { state: "free" })).toBe(CURRENCY_UNKNOWN_LABEL);
  });

  it("an invalid amount renders an explicit label instead of throwing", () => {
    expect(formatTransactionAmount(12.5, USD)).toBe(INVALID_AMOUNT_LABEL);
    expect(formatTransactionAmount(Number.NaN, ALL)).toBe(INVALID_AMOUNT_LABEL);
  });
});

describe("mergeCurrencyProvenances", () => {
  it("agreeing rows resolve", () => {
    expect(mergeCurrencyProvenances([ALL, ALL])).toEqual(ALL);
  });

  it("two different currencies are a conflict, never one picked", () => {
    expect(mergeCurrencyProvenances([ALL, USD])).toEqual({ state: "conflict" });
  });

  it("any conflict wins", () => {
    expect(mergeCurrencyProvenances([ALL, { state: "conflict" }])).toEqual({ state: "conflict" });
  });

  it("a known currency next to an unknown row is only unknown", () => {
    expect(mergeCurrencyProvenances([USD, { state: "unknown" }])).toEqual({ state: "unknown" });
  });

  it("free rows never outvote a real currency", () => {
    expect(mergeCurrencyProvenances([{ state: "free" }, ALL])).toEqual(ALL);
    expect(mergeCurrencyProvenances([{ state: "free" }])).toEqual({ state: "free" });
  });

  it("no rows at all is unknown", () => {
    expect(mergeCurrencyProvenances([])).toEqual({ state: "unknown" });
  });
});

describe("sumMinorUnitsByCurrency", () => {
  it("never adds across currencies", () => {
    const result = sumMinorUnitsByCurrency([
      { amountMinor: 999, provenance: USD },
      { amountMinor: 9900, provenance: ALL },
      { amountMinor: 1, provenance: USD },
      { amountMinor: 100, provenance: ALL },
    ]);
    expect(result).toEqual({
      totals: [
        { currency: "ALL", amountMinor: 10000 },
        { currency: "USD", amountMinor: 1000 },
      ],
      unresolvedCount: 0,
    });
  });

  it("counts, but never sums, rows without a resolved supported currency", () => {
    const result = sumMinorUnitsByCurrency([
      { amountMinor: 999, provenance: USD },
      { amountMinor: 500, provenance: { state: "unknown" } },
      { amountMinor: 600, provenance: { state: "conflict" } },
      { amountMinor: 700, provenance: { state: "unsupported", currency: "EUR" } },
      { amountMinor: 0, provenance: { state: "free" } },
    ]);
    expect(result).toEqual({ totals: [{ currency: "USD", amountMinor: 999 }], unresolvedCount: 3 });
  });

  it("keeps negative ledger-style amounts", () => {
    expect(
      sumMinorUnitsByCurrency([
        { amountMinor: 1000, provenance: ALL },
        { amountMinor: -1500, provenance: ALL },
      ]).totals,
    ).toEqual([{ currency: "ALL", amountMinor: -500 }]);
  });

  it("an empty input has no totals at all -- not a zero in some default currency", () => {
    expect(sumMinorUnitsByCurrency([])).toEqual({ totals: [], unresolvedCount: 0 });
  });

  it("refuses a non-integer amount and an unsafe running total", () => {
    expect(() => sumMinorUnitsByCurrency([{ amountMinor: 1.5, provenance: USD }])).toThrow();
    expect(() =>
      sumMinorUnitsByCurrency([
        { amountMinor: Number.MAX_SAFE_INTEGER, provenance: USD },
        { amountMinor: 1, provenance: USD },
      ]),
    ).toThrow();
  });
});

describe("transaction-money module: integer-only by construction", () => {
  const source = readFileSync(join(process.cwd(), "src/lib/transaction-money.ts"), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*"))
    .join("\n");

  it("has no imports and cannot reach env, network or a database", () => {
    expect(code).not.toMatch(/^import /m);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/supabase/i);
  });

  it("never divides, rounds, or uses Intl/toFixed/parseFloat", () => {
    expect(code).not.toMatch(/\/\s*100\b/);
    expect(code).not.toMatch(/\btoFixed\b/);
    expect(code).not.toMatch(/\bMath\.(round|floor|ceil|trunc)\b/);
    expect(code).not.toMatch(/\bparseFloat\b/);
    expect(code).not.toMatch(/\bIntl\b/);
    expect(code).not.toMatch(/toLocaleString/);
  });

  it("never emits a dollar sign", () => {
    expect(code).not.toMatch(/`\$\$\{/);
    expect(code).not.toMatch(/["']\$["']/);
  });
});
