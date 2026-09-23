import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  FIXED_ALL_DISCOUNT_FORM_TYPE,
  LEGACY_USD_DISCOUNT_NOTICE,
  MAXIMUM_FIXED_DISCOUNT_ALL,
  MINIMUM_FIXED_DISCOUNT_ALL,
  describeDiscountCode,
  formatFixedDiscountAll,
  parseFixedDiscountAll,
} from "./discount-amount";
import { MINIMUM_PAID_CATALOG_PRICE_ALL, parseCatalogPriceAll } from "./catalog-price";

// ALL-DISCOUNT-3: the fixed ALL discount parser, formatter and display.

describe("fixed ALL discount domain", () => {
  it("is exactly the amount_off_all CHECK constraint: 1..100000", () => {
    expect(MINIMUM_FIXED_DISCOUNT_ALL).toBe(1);
    expect(MAXIMUM_FIXED_DISCOUNT_ALL).toBe(100_000);
    // The constraint text in schema.sql, so a change to either side is
    // caught here rather than by an author meeting a CHECK error.
    const schema = readFileSync(path.join(__dirname, "../../supabase/schema.sql"), "utf8");
    expect(schema).toContain("or (amount_off_all >= 1 and amount_off_all <= 100000)");
  });

  it("uses a form type that is not the old USD 'amount' value", () => {
    expect(FIXED_ALL_DISCOUNT_FORM_TYPE).toBe("amount_all");
    expect(FIXED_ALL_DISCOUNT_FORM_TYPE).not.toBe("amount");
  });
});

describe("parseFixedDiscountAll: accepted inputs", () => {
  it.each([
    ["1", 1],
    ["2", 2],
    ["50", 50],
    ["98", 98],
    ["99", 99],
    ["250", 250],
    ["99999", 99_999],
    ["100000", 100_000],
  ])("%j -> %d", (input, expected) => {
    expect(parseFixedDiscountAll(input)).toEqual({ ok: true, amountOffAll: expected });
  });

  it("accepts values below the catalog's 99 ALL paid floor, which does not apply to discounts", () => {
    expect(MINIMUM_PAID_CATALOG_PRICE_ALL).toBe(99);
    for (const input of ["1", "10", "98"]) {
      expect(parseFixedDiscountAll(input).ok).toBe(true);
      // ...while the catalog parser refuses the same strings.
      expect(parseCatalogPriceAll(input).ok).toBe(false);
    }
  });

  it.each([
    ["250,00", 250],
    ["250.00", 250],
    ["1,00", 1],
    ["1.00", 1],
    ["100000,00", 100_000],
    ["100000.00", 100_000],
  ])("accepts a zero fractional part: %j -> %d", (input, expected) => {
    expect(parseFixedDiscountAll(input)).toEqual({ ok: true, amountOffAll: expected });
  });

  it.each([
    ["  250  ", 250],
    ["\t250\n", 250],
    ["0250", 250],
    ["00001", 1],
    ["0100000", 100_000],
    ["000250,00", 250],
  ])("trims whitespace and normalizes leading zeros: %j -> %d", (input, expected) => {
    expect(parseFixedDiscountAll(input)).toEqual({ ok: true, amountOffAll: expected });
  });

  it("returns an integer, never a float-derived value", () => {
    for (let n = 1; n <= 2000; n += 1) {
      const parsed = parseFixedDiscountAll(String(n));
      expect(parsed).toEqual({ ok: true, amountOffAll: n });
      if (parsed.ok) expect(Number.isSafeInteger(parsed.amountOffAll)).toBe(true);
    }
  });
});

describe("parseFixedDiscountAll: rejected inputs", () => {
  it.each([
    ["zero", "0"],
    ["zero with decimals", "0,00"],
    ["zero with dot decimals", "0.00"],
    ["zero padded", "000"],
    ["above the maximum", "100001"],
    ["above the maximum, zero-padded", "000100001"],
    ["above the maximum with decimals", "100001,00"],
    ["far above", "999999999"],
  ])("out of range: %s (%j)", (_label, input) => {
    expect(parseFixedDiscountAll(input)).toEqual({ ok: false });
  });

  it.each([
    ["nonzero comma fraction", "250,50"],
    ["nonzero dot fraction", "250.50"],
    ["one-digit fraction", "250.5"],
    ["one-digit zero fraction", "250.0"],
    ["three-digit fraction", "250.000"],
    ["tiny nonzero fraction", "250,01"],
    ["fraction only", ".50"],
    ["trailing separator", "250."],
    ["leading separator", ",00"],
  ])("fractions: %s (%j)", (_label, input) => {
    expect(parseFixedDiscountAll(input)).toEqual({ ok: false });
  });

  it.each([
    ["exponent", "1e3"],
    ["upper exponent", "1E3"],
    ["exponent with decimals", "2.5e2"],
    ["plus sign", "+250"],
    ["minus sign", "-250"],
    ["negative zero", "-0"],
    ["hex", "0x10"],
    ["binary", "0b11"],
    ["octal", "0o7"],
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
  ])("numeric notations: %s (%j)", (_label, input) => {
    expect(parseFixedDiscountAll(input)).toEqual({ ok: false });
  });

  it.each([
    ["dot thousands", "1.000"],
    ["comma thousands", "1,000"],
    ["space thousands", "1 000"],
    ["non-breaking space thousands", "1 000"],
    ["mixed grouping", "1.000,00"],
    ["US grouping", "1,000.00"],
    ["underscore separator", "1_000"],
    ["apostrophe grouping", "1'000"],
  ])("grouping separators: %s (%j)", (_label, input) => {
    expect(parseFixedDiscountAll(input)).toEqual({ ok: false });
  });

  it.each([
    ["empty", ""],
    ["spaces", "   "],
    ["tab and newline", "\t\n"],
    ["currency suffix", "250 ALL"],
    ["currency prefix", "ALL 250"],
    ["lek suffix", "250L"],
    ["dollar", "$5"],
    ["letters", "abc"],
    ["Arabic-Indic digits", "٢٥٠"],
    ["full-width digits", "２５０"],
    ["inner whitespace", "2 50"],
  ])("non-numeric or whitespace-only: %s (%j)", (_label, input) => {
    expect(parseFixedDiscountAll(input)).toEqual({ ok: false });
  });

  it("rejects an oversized input before any numeric step", () => {
    expect(parseFixedDiscountAll("0".repeat(31) + "1")).toEqual({ ok: true, amountOffAll: 1 });
    expect(parseFixedDiscountAll("0".repeat(32) + "1")).toEqual({ ok: false });
    expect(parseFixedDiscountAll("9".repeat(400))).toEqual({ ok: false });
    expect(parseFixedDiscountAll("1".repeat(100_000))).toEqual({ ok: false });
  });

  it("rejects an integer part beyond safe-integer range", () => {
    expect(parseFixedDiscountAll("9007199254740993")).toEqual({ ok: false });
  });

  it.each([
    ["number", 250],
    ["bigint", BigInt(250)],
    ["null", null],
    ["undefined", undefined],
    ["boolean", true],
    ["object", { value: "250" }],
    ["array", ["250"]],
    ["File", new File(["250"], "value.txt")],
  ])("non-string: %s", (_label, input) => {
    expect(parseFixedDiscountAll(input)).toEqual({ ok: false });
  });
});

describe("formatFixedDiscountAll", () => {
  it.each([
    [1, "1,00 ALL"],
    [98, "98,00 ALL"],
    [99, "99,00 ALL"],
    [250, "250,00 ALL"],
    [999, "999,00 ALL"],
    [1000, "1.000,00 ALL"],
    [12345, "12.345,00 ALL"],
    [100_000, "100.000,00 ALL"],
  ])("%d -> %j (no catalog minimum applied)", (input, expected) => {
    expect(formatFixedDiscountAll(input)).toBe(expected);
  });

  it.each([0, -1, 100_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    "throws outside the domain: %s",
    (input) => {
      expect(() => formatFixedDiscountAll(input)).toThrow(/not a valid fixed ALL discount/);
    },
  );

  it("never echoes the invalid value in its error", () => {
    expect(() => formatFixedDiscountAll(123456789)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("123456789") }),
    );
  });
});

describe("describeDiscountCode", () => {
  const none = { percent_off: null, amount_off_cents: null, amount_off_all: null };

  it("percentage codes are displayed exactly as before", () => {
    expect(describeDiscountCode({ ...none, percent_off: 1 })).toEqual({ kind: "percent", label: "1% off" });
    expect(describeDiscountCode({ ...none, percent_off: 20 })).toEqual({ kind: "percent", label: "20% off" });
    expect(describeDiscountCode({ ...none, percent_off: 100 })).toEqual({ kind: "percent", label: "100% off" });
  });

  it("fixed ALL codes are displayed in lek without the catalog minimum", () => {
    expect(describeDiscountCode({ ...none, amount_off_all: 1 })).toEqual({ kind: "fixed_all", label: "1,00 ALL off" });
    expect(describeDiscountCode({ ...none, amount_off_all: 50 })).toEqual({ kind: "fixed_all", label: "50,00 ALL off" });
    expect(describeDiscountCode({ ...none, amount_off_all: 2500 })).toEqual({
      kind: "fixed_all",
      label: "2.500,00 ALL off",
    });
  });

  it("legacy amount_off_cents codes are USD, marked inapplicable, and never labelled as ALL", () => {
    const display = describeDiscountCode({ ...none, amount_off_cents: 500 });
    expect(display).toEqual({ kind: "legacy_usd", label: "USD 5.00 off", notice: LEGACY_USD_DISCOUNT_NOTICE });
    expect(LEGACY_USD_DISCOUNT_NOTICE).toMatch(/legacy/i);
    expect(LEGACY_USD_DISCOUNT_NOTICE).toMatch(/not applicable to ALL checkout/);
    // The number is never presented as lek, in either spelling.
    expect(display.label).not.toMatch(/ALL/);
    expect(display.label).not.toMatch(/5,00|500,00/);
  });

  it.each([
    [1, "USD 0.01 off"],
    [99, "USD 0.99 off"],
    [100, "USD 1.00 off"],
    [1999, "USD 19.99 off"],
    [123456, "USD 1,234.56 off"],
  ])("legacy cents %d render exactly as %j (integer slicing, no float)", (cents, label) => {
    expect(describeDiscountCode({ ...none, amount_off_cents: cents }).label).toBe(label);
  });

  it("any shape the CHECK constraint forbids is unrecognized, never guessed", () => {
    for (const shape of [
      none,
      { percent_off: 10, amount_off_cents: 500, amount_off_all: null },
      { percent_off: 10, amount_off_cents: null, amount_off_all: 100 },
      { percent_off: null, amount_off_cents: 500, amount_off_all: 100 },
      { ...none, percent_off: 0 },
      { ...none, percent_off: 101 },
      { ...none, percent_off: 12.5 },
      { ...none, amount_off_all: 0 },
      { ...none, amount_off_all: 100_001 },
      { ...none, amount_off_all: 1.5 },
      { ...none, amount_off_cents: 0 },
      { ...none, amount_off_cents: -500 },
      { ...none, amount_off_cents: 1.5 },
    ]) {
      expect(describeDiscountCode(shape)).toEqual({ kind: "unrecognized", label: "Unrecognized discount" });
    }
  });
});

describe("module purity", () => {
  it("has no imports at all", () => {
    const source = readFileSync(path.join(__dirname, "discount-amount.ts"), "utf8");
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
    expect(source).not.toMatch(/process\.env/);
  });

  it("derives no stored value through floating-point parsing", () => {
    // Code only: the module's comments name these functions on purpose.
    const code = readFileSync(path.join(__dirname, "discount-amount.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(code).toContain("function parseFixedDiscountAll");
    expect(code).not.toMatch(/parseFloat|parseInt|Math\.round|\* ?100\b|\/ ?100\b/);
  });
});
