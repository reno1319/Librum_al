import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, afterEach, vi } from "vitest";
import {
  MINIMUM_PAID_CATALOG_PRICE_ALL,
  MAXIMUM_CATALOG_PRICE_ALL,
  parseCatalogPriceAll,
  classifyCatalogPrice,
  formatCatalogPriceAll,
} from "./catalog-price";

describe("MINIMUM_PAID_CATALOG_PRICE_ALL / MAXIMUM_CATALOG_PRICE_ALL", () => {
  it("are the owner-confirmed 99 ALL floor and 100,000 ALL ceiling", () => {
    expect(MINIMUM_PAID_CATALOG_PRICE_ALL).toBe(99);
    expect(MAXIMUM_CATALOG_PRICE_ALL).toBe(100_000);
  });
});

describe("parseCatalogPriceAll: accepted free forms", () => {
  it("accepts 0", () => {
    expect(parseCatalogPriceAll("0")).toEqual({ ok: true, priceAll: 0 });
  });

  it("accepts 0,00 and 0.00", () => {
    expect(parseCatalogPriceAll("0,00")).toEqual({ ok: true, priceAll: 0 });
    expect(parseCatalogPriceAll("0.00")).toEqual({ ok: true, priceAll: 0 });
  });

  it("accepts and normalizes zero-prefixed free forms (00, 000, 000,00, 000.00)", () => {
    expect(parseCatalogPriceAll("00")).toEqual({ ok: true, priceAll: 0 });
    expect(parseCatalogPriceAll("000")).toEqual({ ok: true, priceAll: 0 });
    expect(parseCatalogPriceAll("000,00")).toEqual({ ok: true, priceAll: 0 });
    expect(parseCatalogPriceAll("000.00")).toEqual({ ok: true, priceAll: 0 });
  });
});

describe("parseCatalogPriceAll: accepted paid forms", () => {
  it("accepts 99 (the paid floor) and its dot/comma zero-decimal forms", () => {
    expect(parseCatalogPriceAll("99")).toEqual({ ok: true, priceAll: 99 });
    expect(parseCatalogPriceAll("99,00")).toEqual({ ok: true, priceAll: 99 });
    expect(parseCatalogPriceAll("99.00")).toEqual({ ok: true, priceAll: 99 });
  });

  it("accepts 250 and its dot/comma zero-decimal forms", () => {
    expect(parseCatalogPriceAll("250")).toEqual({ ok: true, priceAll: 250 });
    expect(parseCatalogPriceAll("250,00")).toEqual({ ok: true, priceAll: 250 });
    expect(parseCatalogPriceAll("250.00")).toEqual({ ok: true, priceAll: 250 });
  });

  // Owner-confirmed normalization: leading zeros on a paid amount are
  // accepted, not rejected -- "099" and "00099" both mean 99 ALL, the
  // same value "99" alone means.
  it("accepts and normalizes zero-prefixed paid forms (099, 00099, with dot/comma zero-decimals)", () => {
    expect(parseCatalogPriceAll("099")).toEqual({ ok: true, priceAll: 99 });
    expect(parseCatalogPriceAll("00099")).toEqual({ ok: true, priceAll: 99 });
    expect(parseCatalogPriceAll("00099,00")).toEqual({ ok: true, priceAll: 99 });
    expect(parseCatalogPriceAll("00099.00")).toEqual({ ok: true, priceAll: 99 });
    expect(parseCatalogPriceAll("00100")).toEqual({ ok: true, priceAll: 100 });
  });

  it("trims surrounding whitespace", () => {
    expect(parseCatalogPriceAll("  99  ")).toEqual({ ok: true, priceAll: 99 });
    expect(parseCatalogPriceAll("\t250,00\n")).toEqual({ ok: true, priceAll: 250 });
  });
});

describe("parseCatalogPriceAll: maximum boundary", () => {
  it("accepts the maximum (100000) and its dot/comma zero-decimal forms", () => {
    expect(parseCatalogPriceAll("100000")).toEqual({ ok: true, priceAll: 100_000 });
    expect(parseCatalogPriceAll("100000,00")).toEqual({ ok: true, priceAll: 100_000 });
    expect(parseCatalogPriceAll("100000.00")).toEqual({ ok: true, priceAll: 100_000 });
  });

  it("accepts a zero-prefixed form of the maximum", () => {
    expect(parseCatalogPriceAll("0100000")).toEqual({ ok: true, priceAll: 100_000 });
  });

  it("rejects one ALL above the maximum, including its zero-decimal and zero-prefixed forms", () => {
    expect(parseCatalogPriceAll("100001")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("100001,00")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("100001.00")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("0100001")).toEqual({ ok: false });
  });
});

describe("parseCatalogPriceAll: whitespace/length ordering (trim happens before the length check)", () => {
  it("does not reject a short valid value merely because extensive surrounding whitespace makes the RAW string long", () => {
    const padded = " ".repeat(50) + "99" + " ".repeat(50);
    expect(padded.length).toBeGreaterThan(32); // the raw string alone would exceed the limit
    expect(parseCatalogPriceAll(padded)).toEqual({ ok: true, priceAll: 99 });
  });

  it("still rejects an excessively long TRIMMED numeric value", () => {
    expect(parseCatalogPriceAll("9".repeat(64))).toEqual({ ok: false });
  });

  it("rejects an extremely long zero-prefixed payload after trimming, even though it would mathematically reduce to a valid price", () => {
    const huge = "0".repeat(40) + "99"; // reduces to 99, but the trimmed string itself is far past the length limit
    expect(huge.trim().length).toBeGreaterThan(32);
    expect(parseCatalogPriceAll(huge)).toEqual({ ok: false });
  });
});

describe("parseCatalogPriceAll: rejected", () => {
  it("rejects empty input", () => {
    expect(parseCatalogPriceAll("")).toEqual({ ok: false });
  });

  it("rejects whitespace-only input", () => {
    expect(parseCatalogPriceAll("   ")).toEqual({ ok: false });
  });

  it("rejects every paid value from 1 through 98, including zero-prefixed forms", () => {
    for (let i = 1; i <= 98; i++) {
      expect(parseCatalogPriceAll(String(i))).toEqual({ ok: false });
    }
    expect(parseCatalogPriceAll("098")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("0098")).toEqual({ ok: false });
  });

  it("rejects 98,99 (nonzero fraction, and below the floor)", () => {
    expect(parseCatalogPriceAll("98,99")).toEqual({ ok: false });
  });

  it("rejects nonzero fractional parts, including on otherwise-valid zero-prefixed amounts", () => {
    expect(parseCatalogPriceAll("99,01")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("99.50")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("00099,01")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("00099.50")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("000,01")).toEqual({ ok: false });
  });

  it("rejects negative values", () => {
    expect(parseCatalogPriceAll("-99")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("-1")).toEqual({ ok: false });
  });

  it("rejects negative zero", () => {
    expect(parseCatalogPriceAll("-0")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("-0,00")).toEqual({ ok: false });
  });

  it("rejects a leading plus sign", () => {
    expect(parseCatalogPriceAll("+99")).toEqual({ ok: false });
  });

  it("rejects exponent notation", () => {
    expect(parseCatalogPriceAll("9.9e1")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("1e2")).toEqual({ ok: false });
  });

  // Grouping separators are never inferred from author input, even
  // though "." is used as the THOUSANDS separator in reader-facing
  // display -- parsing and formatting are deliberately different
  // grammars. "1.000" is not "one thousand"; it fails the exactly-two-
  // decimal-digit shape and must be rejected outright, never
  // reinterpreted.
  it("rejects grouping separators, never interpreting them as thousands", () => {
    expect(parseCatalogPriceAll("1,234")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("1.234")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("1.000")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("100.000")).toEqual({ ok: false });
  });

  it("rejects mixed comma/dot formats", () => {
    expect(parseCatalogPriceAll("1.234,56")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("1,234.56")).toEqual({ ok: false });
  });

  it("rejects malformed separators", () => {
    expect(parseCatalogPriceAll("99,")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("99.")).toEqual({ ok: false });
    expect(parseCatalogPriceAll(",99")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("99,0")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("99,000")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("9,9,9")).toEqual({ ok: false });
  });

  it("rejects an integer part unsafe for exact integer arithmetic", () => {
    expect(parseCatalogPriceAll("99999999999999999999")).toEqual({ ok: false });
  });

  it("rejects the literal string NaN", () => {
    expect(parseCatalogPriceAll("NaN")).toEqual({ ok: false });
  });

  it("rejects the literal string Infinity", () => {
    expect(parseCatalogPriceAll("Infinity")).toEqual({ ok: false });
    expect(parseCatalogPriceAll("-Infinity")).toEqual({ ok: false });
  });

  it("rejects non-string input types (e.g. a raw FormData value)", () => {
    expect(parseCatalogPriceAll(99)).toEqual({ ok: false });
    expect(parseCatalogPriceAll(null)).toEqual({ ok: false });
    expect(parseCatalogPriceAll(undefined)).toEqual({ ok: false });
    expect(parseCatalogPriceAll({})).toEqual({ ok: false });
    expect(parseCatalogPriceAll([])).toEqual({ ok: false });
    expect(parseCatalogPriceAll(new File(["x"], "x.txt"))).toEqual({ ok: false });
  });
});

// Both classifyCatalogPrice and formatCatalogPriceAll must enforce the
// exact same canonical domain parseCatalogPriceAll accepts into -- they
// no longer trust a "caller already validated this" comment. Every
// value outside {0} ∪ [99, 100000] throws, for every exported function.
describe("classifyCatalogPrice: domain enforcement", () => {
  it("classifies 0 as free", () => {
    expect(classifyCatalogPrice(0)).toBe("free");
  });

  it("classifies the floor (99) as paid", () => {
    expect(classifyCatalogPrice(99)).toBe("paid");
  });

  it("classifies the maximum (100000) as paid", () => {
    expect(classifyCatalogPrice(100_000)).toBe("paid");
  });

  it("classifies a mid-range value as paid", () => {
    expect(classifyCatalogPrice(250)).toBe("paid");
  });

  it("throws for values below the floor (but not exactly 0)", () => {
    expect(() => classifyCatalogPrice(1)).toThrow();
    expect(() => classifyCatalogPrice(98)).toThrow();
  });

  it("throws for values above the maximum", () => {
    expect(() => classifyCatalogPrice(100_001)).toThrow();
  });

  it("throws for negative values, fractions, NaN, Infinity, and unsafe integers", () => {
    expect(() => classifyCatalogPrice(-1)).toThrow();
    expect(() => classifyCatalogPrice(99.5)).toThrow();
    expect(() => classifyCatalogPrice(Number.NaN)).toThrow();
    expect(() => classifyCatalogPrice(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => classifyCatalogPrice(Number.MAX_SAFE_INTEGER + 10)).toThrow();
  });

  // Number.isSafeInteger(-0) and (-0 === 0) are both true in JS, so this
  // specifically exercises the Object.is(-0) check in the shared
  // validator, not the generic negative-value case above.
  it("throws for numeric negative zero, while positive zero remains valid", () => {
    expect(() => classifyCatalogPrice(-0)).toThrow();
    expect(classifyCatalogPrice(0)).toBe("free");
  });

  it("never includes the raw invalid value in the thrown message", () => {
    let thrown: unknown;
    try {
      classifyCatalogPrice(100_001);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain("100001");
  });
});

// Owner-confirmed display convention: comma decimal separator, dot
// thousands separator, always exactly two display decimals.
describe("formatCatalogPriceAll: formatting and domain enforcement", () => {
  it("formats 0 as 0,00 ALL", () => {
    expect(formatCatalogPriceAll(0)).toBe("0,00 ALL");
  });

  it("formats 99 as 99,00 ALL", () => {
    expect(formatCatalogPriceAll(99)).toBe("99,00 ALL");
  });

  it("formats 199 as 199,00 ALL", () => {
    expect(formatCatalogPriceAll(199)).toBe("199,00 ALL");
  });

  it("formats 1000 as 1.000,00 ALL", () => {
    expect(formatCatalogPriceAll(1000)).toBe("1.000,00 ALL");
  });

  it("formats the maximum (100000) as 100.000,00 ALL", () => {
    expect(formatCatalogPriceAll(100_000)).toBe("100.000,00 ALL");
  });

  it("throws for values below the floor, above the maximum, negative, fractional, NaN, Infinity, or unsafe integers", () => {
    expect(() => formatCatalogPriceAll(1)).toThrow();
    expect(() => formatCatalogPriceAll(98)).toThrow();
    expect(() => formatCatalogPriceAll(100_001)).toThrow();
    expect(() => formatCatalogPriceAll(-1)).toThrow();
    expect(() => formatCatalogPriceAll(1.5)).toThrow();
    expect(() => formatCatalogPriceAll(Number.NaN)).toThrow();
    expect(() => formatCatalogPriceAll(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => formatCatalogPriceAll(Number.MAX_SAFE_INTEGER + 10)).toThrow();
  });

  // Number.isSafeInteger(-0) and (-0 === 0) are both true in JS, so this
  // specifically exercises the Object.is(-0) check in the shared
  // validator, not the generic negative-value case above.
  it("throws for numeric negative zero, while positive zero still formats as 0,00 ALL", () => {
    expect(() => formatCatalogPriceAll(-0)).toThrow();
    expect(formatCatalogPriceAll(0)).toBe("0,00 ALL");
  });

  it("never includes the raw invalid value in the thrown message", () => {
    let thrown: unknown;
    try {
      formatCatalogPriceAll(100_001);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain("100001");
  });
});

// Purity. Direct source review (this file exists precisely so a reviewer
// reads the actual code, not a summary of it), zero production
// importers (verified separately, outside this test run -- see the
// review package's own grep), and the deterministic, synchronous
// behavior asserted below are the PRIMARY evidence that this module is
// safe to leave unwired. The static source-string scan further down is
// kept only as supplemental, defense-in-depth evidence -- it is not
// relied on as the sole proof.
describe("catalog-price module: performs no side effects", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("never calls fetch, across every exported function", () => {
    globalThis.fetch = vi.fn(() => {
      throw new Error("catalog-price.ts must never call fetch");
    }) as unknown as typeof fetch;

    parseCatalogPriceAll("99,00");
    classifyCatalogPrice(99);
    formatCatalogPriceAll(99);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("every exported function is synchronous, never returning a Promise", () => {
    expect(parseCatalogPriceAll("99") instanceof Promise).toBe(false);
    // classifyCatalogPrice/formatCatalogPriceAll return string-typed
    // values, so TS already forbids `instanceof Promise` on them --
    // typeof "string" is itself sufficient proof they're not a Promise
    // (a Promise's typeof is always "object").
    expect(typeof classifyCatalogPrice(99)).toBe("string");
    expect(typeof formatCatalogPriceAll(99)).toBe("string");
  });

  // Supplemental only (see the describe-block comment above): a dynamic
  // process.env spy would risk false failures from unrelated code
  // (vitest/Node internals) touching process.env during the same test
  // run, so this is a static scan of catalog-price.ts's own source --
  // not a substitute for reading the file directly.
  it("supplemental: its own source never references process.env, fetch, a database/provider client, or the filesystem, and has no imports", () => {
    const sourcePath = fileURLToPath(new URL("./catalog-price.ts", import.meta.url));
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/supabase/i);
    expect(source).not.toMatch(/\bawait\b/);
    expect(source).not.toMatch(/node:fs|node:path|node:url/);
    expect(source).not.toMatch(/^import /m);
  });
});
