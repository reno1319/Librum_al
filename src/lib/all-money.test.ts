import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_FREE_LABEL, formatAllMinorUnits } from "./all-money";

// ALL-WIRING-2. This module exists because
// `Intl.NumberFormat(locale, { style: "currency", currency: "ALL" })`
// resolves to minimumFractionDigits 0 under this runtime's CLDR data:
// it renders 179,10 lek as "ALL 179" and silently discards the
// qindarka. A currency formatter that drops minor units is worse than
// no formatter at all, because every figure it produces still looks
// right.
//
// So the contract here is narrow and total: a non-negative safe integer
// count of ALL minor units in, an Albanian-convention display string
// out, and a throw for everything else. The tests are written as EXACT
// string equality, never `toContain` or a regex -- a separator that
// swapped places (99.00 instead of 99,00) is precisely the defect a
// loose matcher waves through.

describe("formatAllMinorUnits: the four contract examples, exactly", () => {
  it("0 is the free label, not 0,00 ALL", () => {
    expect(formatAllMinorUnits(0)).toBe("Free");
    expect(formatAllMinorUnits(0)).toBe(ALL_FREE_LABEL);
  });

  it("9900 is 99,00 ALL", () => {
    expect(formatAllMinorUnits(9900)).toBe("99,00 ALL");
  });

  it("17910 is 179,10 ALL -- the qindarka Intl would have dropped", () => {
    expect(formatAllMinorUnits(17910)).toBe("179,10 ALL");
  });

  it("10000000 is 100.000,00 ALL -- dot groups thousands, comma separates decimals", () => {
    expect(formatAllMinorUnits(10000000)).toBe("100.000,00 ALL");
  });
});

describe("formatAllMinorUnits: separators are never swapped", () => {
  // Written as a table of exact strings because the Albanian convention
  // is the mirror image of the en-US one, and "looks formatted" is not
  // the property under test.
  const cases: Array<[number, string]> = [
    [1, "0,01 ALL"],
    [9, "0,09 ALL"],
    [10, "0,10 ALL"],
    [99, "0,99 ALL"],
    [100, "1,00 ALL"],
    [101, "1,01 ALL"],
    [999, "9,99 ALL"],
    [1000, "10,00 ALL"],
    [99999, "999,99 ALL"],
    [100000, "1.000,00 ALL"],
    [100001, "1.000,01 ALL"],
    [999999, "9.999,99 ALL"],
    [1000000, "10.000,00 ALL"],
    [99999999, "999.999,99 ALL"],
    [100000000, "1.000.000,00 ALL"],
    [123456789, "1.234.567,89 ALL"],
    [1000000000, "10.000.000,00 ALL"],
  ];

  it.each(cases)("%i formats as %s", (minor, expected) => {
    expect(formatAllMinorUnits(minor)).toBe(expected);
  });

  it("never emits a dollar sign, a currency symbol, or a bare ALL prefix", () => {
    for (const [minor] of cases) {
      const out = formatAllMinorUnits(minor);
      expect(out).not.toContain("$");
      expect(out).not.toContain("\u20ac");
      // Only the three-letter code, never the bare "L"/"Lek" symbol
      // forms -- checked as "no letter outside the ALL suffix" rather
      // than "contains no L", since ALL itself is full of them.
      expect(out.replace(/ ALL$/, "")).not.toMatch(/[A-Za-z]/);
      // The suffix form, never Intl's "ALL 179" prefix form.
      expect(out.endsWith(" ALL")).toBe(true);
      expect(out.startsWith("ALL")).toBe(false);
    }
  });

  it("always shows exactly two decimal digits", () => {
    for (const [, expected] of cases) {
      expect(expected).toMatch(/,\d{2} ALL$/);
    }
    // And the same property computed rather than read off the table.
    for (let minor = 1; minor <= 2000; minor += 1) {
      expect(formatAllMinorUnits(minor)).toMatch(/^\d{1,3}(\.\d{3})*,\d{2} ALL$/);
    }
  });
});

describe("formatAllMinorUnits: integer-only, with no rounding to lose", () => {
  // 0.1 + 0.2 !== 0.3 is the canonical float failure; the minor-unit
  // equivalents of those three amounts must come back exact.
  it("is exact for the values a divide-by-100 implementation would round", () => {
    expect(formatAllMinorUnits(10)).toBe("0,10 ALL");
    expect(formatAllMinorUnits(20)).toBe("0,20 ALL");
    expect(formatAllMinorUnits(30)).toBe("0,30 ALL");
    expect(formatAllMinorUnits(70)).toBe("0,70 ALL");
    expect(formatAllMinorUnits(8100)).toBe("81,00 ALL");
  });

  it("is exact at the very top of the safe-integer range", () => {
    expect(formatAllMinorUnits(Number.MAX_SAFE_INTEGER)).toBe(
      "90.071.992.547.409,91 ALL",
    );
  });

  // The bug this module's slicing avoids, ASSERTED rather than claimed:
  // near the top of the safe-integer range `minor / 100` is no longer
  // exactly representable, so `toFixed(2)` reports a different qindarka
  // from the one the integer actually holds. 9007199254000001 minor
  // units is ...,01 and the naive route calls it ...,02.
  it("disagrees with a divide-then-toFixed implementation exactly where floating point does", () => {
    const minor = 9007199254000001;
    expect(Number.isSafeInteger(minor)).toBe(true);
    expect(formatAllMinorUnits(minor)).toBe("90.071.992.540.000,01 ALL");
    expect((minor / 100).toFixed(2)).toBe("90071992540000.02");
  });

  it("every whole-lek catalog price in the 99..100000 domain converts exactly", () => {
    for (let priceAll = 99; priceAll <= 100000; priceAll += 1) {
      const formatted = formatAllMinorUnits(priceAll * 100);
      // The minor part of a whole-lek amount is always ",00".
      expect(formatted.endsWith(",00 ALL")).toBe(true);
      // ...and the whole part, with grouping removed, is the price back.
      const whole = formatted.slice(0, -",00 ALL".length).replace(/\./g, "");
      expect(whole).toBe(String(priceAll));
    }
  });
});

describe("formatAllMinorUnits: rejects everything that is not a minor-unit count", () => {
  const rejected: Array<[string, number]> = [
    ["a negative amount", -1],
    ["a large negative amount", -9900],
    ["negative zero", -0],
    ["a fractional amount", 99.5],
    ["a barely-fractional amount", 9900.0000001],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
  ];

  it.each(rejected)("throws for %s", (_label, value) => {
    expect(() => formatAllMinorUnits(value)).toThrow();
  });

  // -0 is the one that slips through `Number.isSafeInteger(x) && x >= 0`
  // and formats as a perfectly innocent "Free" unless Object.is is used.
  it("rejects negative zero specifically, while positive zero is still Free", () => {
    expect(() => formatAllMinorUnits(-0)).toThrow();
    expect(formatAllMinorUnits(0)).toBe("Free");
  });

  it("never echoes the offending value back in the message", () => {
    for (const probe of [-424242, 99.5, Number.MAX_SAFE_INTEGER + 2]) {
      try {
        formatAllMinorUnits(probe);
        throw new Error("expected formatAllMinorUnits to throw");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("ALL minor units");
        expect(message).not.toContain(String(probe));
      }
    }
  });

  it("rejects non-number inputs that a loose caller could still pass at runtime", () => {
    const loose = formatAllMinorUnits as unknown as (value: unknown) => string;
    for (const value of [null, undefined, "9900", "", {}, [], true, BigInt(9900)]) {
      expect(() => loose(value)).toThrow();
    }
  });
});

describe("all-money module: integer-only by construction, not by convention", () => {
  const source = readFileSync(
    fileURLToPath(new URL("./all-money.ts", import.meta.url)),
    "utf8",
  );
  // The comment block explains WHY there is no Intl and no division;
  // these scans are what stop a later edit from quietly reintroducing
  // either. Comments are stripped first, so the prohibition can be
  // DOCUMENTED in the file it applies to without defeating its own
  // check -- the same trap the SQL harness's prosrc probes avoid.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  it("never mentions Intl", () => {
    expect(code).not.toMatch(/\bIntl\b/);
  });

  it("never divides, and never uses toFixed, Math.round, Math.floor or parseFloat", () => {
    expect(code).not.toMatch(/\/\s*100\b/);
    expect(code).not.toMatch(/\btoFixed\b/);
    expect(code).not.toMatch(/\bMath\.(round|floor|ceil|trunc)\b/);
    expect(code).not.toMatch(/\bparseFloat\b/);
    expect(code).not.toMatch(/\bNumber\.parseFloat\b/);
  });

  it("has no imports and no side effects: it cannot reach env, network, or a database", () => {
    // ALL-TXN-CURRENCY-4: exactly one import, the pure shared transaction
    // formatter the digit slicing now lives in -- itself import-free
    // (asserted in transaction-money.test.ts).
    const imports = code.match(/^import .*$/gm) ?? [];
    expect(imports).toEqual([
      'import { formatTransactionMinorUnits } from "@/lib/transaction-money";',
    ]);
    expect(code).not.toMatch(/process\.env/);
    expect(code).not.toMatch(/\bfetch\(/);
    expect(code).not.toMatch(/supabase/i);
    expect(code).not.toMatch(/\bawait\b/);
  });

  it("returns a string synchronously, never a Promise", () => {
    expect(typeof formatAllMinorUnits(9900)).toBe("string");
  });
});
