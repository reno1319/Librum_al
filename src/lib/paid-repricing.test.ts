import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  applyCatalogRowGuard,
  catalogRowGuard,
  isExactlyOneRowWritten,
  resolvePriceUpdateAuthorization,
  CATALOG_ROW_CHANGED_MESSAGE,
  PAID_REPRICING_UNAVAILABLE_MESSAGE,
  type PriceUpdateAuthorization,
} from "./paid-repricing";

// PAID-REPRICING-1: the pure rule, in the exact shape of the table it
// implements. The actions that consume it are driven end to end in
// src/app/(public)/dashboard/paid-repricing-guards.test.ts.

const decide = (currentStatus: string, currentPriceAll: unknown, submittedPriceAll: number) =>
  resolvePriceUpdateAuthorization({ currentStatus, currentPriceAll, submittedPriceAll }).kind;

describe("resolvePriceUpdateAuthorization", () => {
  it.each<[string, string, unknown, number, PriceUpdateAuthorization["kind"]]>([
    ["published, null -> paid", "published", null, 199, "paid_publishing_permission_required"],
    ["published, free -> paid", "published", 0, 199, "paid_publishing_permission_required"],
    ["published, paid -> different paid", "published", 199, 250, "paid_publishing_permission_required"],
    ["published, paid -> same paid", "published", 199, 199, "unchanged_paid_price"],
    ["published, paid -> free", "published", 199, 0, "free_price"],
    ["published, free -> free", "published", 0, 0, "free_price"],
    ["published, null -> free", "published", null, 0, "free_price"],
    ["draft, null -> paid", "draft", null, 199, "paid_price_on_draft"],
    ["draft, free -> paid", "draft", 0, 199, "paid_price_on_draft"],
    ["draft, paid -> different paid", "draft", 199, 250, "paid_price_on_draft"],
    ["draft, paid -> free", "draft", 199, 0, "free_price"],
  ])("%s", (_label, status, current, submitted, expected) => {
    expect(decide(status, current, submitted)).toBe(expected);
  });

  it("an unexpected status is treated as published, never as a draft", () => {
    expect(decide("archived", 0, 199)).toBe("paid_publishing_permission_required");
    expect(decide("", 0, 199)).toBe("paid_publishing_permission_required");
    expect(decide("Draft", 0, 199)).toBe("paid_publishing_permission_required");
  });

  it("an out-of-domain current price_all is not a paid price to keep", () => {
    // 50 is not a valid catalog price (below the 99 floor); keeping it is
    // not "the same paid price".
    expect(decide("published", 50, 50)).toBe("paid_publishing_permission_required");
    expect(decide("published", "199", 199)).toBe("paid_publishing_permission_required");
  });

  it("an invalid submitted price never reads as free", () => {
    expect(decide("published", 0, 50)).toBe("paid_publishing_permission_required");
    expect(decide("draft", 0, Number.NaN)).toBe("paid_publishing_permission_required");
  });
});

describe("catalogRowGuard", () => {
  const current = { status: "published", priceAll: 199 };
  it("free: no condition beyond ownership", () => {
    expect(catalogRowGuard({ kind: "free_price" }, current)).toBeNull();
  });
  it("paid on a draft: the row must still be a draft", () => {
    expect(catalogRowGuard({ kind: "paid_price_on_draft" }, { status: "draft", priceAll: null })).toEqual({
      status: "draft",
    });
  });
  it("unchanged paid price: the row must still be in the exact status and price read", () => {
    expect(catalogRowGuard({ kind: "unchanged_paid_price" }, current)).toEqual({
      status: "published",
      priceAll: 199,
    });
  });
  it("permission granted: proceeds normally", () => {
    expect(catalogRowGuard({ kind: "paid_publishing_permission_required" }, current)).toBeNull();
  });
});

describe("applyCatalogRowGuard uses SQL null semantics", () => {
  function recorder() {
    const calls: Array<[string, string, unknown]> = [];
    const q = {
      eq: (column: string, value: string | number) => (calls.push(["eq", column, value]), q),
      is: (column: string, value: null) => (calls.push(["is", column, value]), q),
    };
    return { q, calls };
  }

  it("a null price condition is IS NULL, never = NULL", () => {
    const { q, calls } = recorder();
    applyCatalogRowGuard(q, { status: "published", priceAll: null });
    expect(calls).toEqual([
      ["eq", "status", "published"],
      ["is", "price_all", null],
    ]);
  });

  it("a numeric price condition is equality, including 0", () => {
    const { q, calls } = recorder();
    applyCatalogRowGuard(q, { status: "draft", priceAll: 0 });
    expect(calls).toEqual([
      ["eq", "status", "draft"],
      ["eq", "price_all", 0],
    ]);
  });

  it("an absent key adds no condition, and a null guard adds none at all", () => {
    const a = recorder();
    applyCatalogRowGuard(a.q, { status: "draft" });
    expect(a.calls).toEqual([["eq", "status", "draft"]]);
    const b = recorder();
    applyCatalogRowGuard(b.q, null);
    expect(b.calls).toEqual([]);
  });
});

describe("isExactlyOneRowWritten", () => {
  it("only an array of exactly one row proves the write", () => {
    expect(isExactlyOneRowWritten([{ id: "x" }])).toBe(true);
    expect(isExactlyOneRowWritten([])).toBe(false);
    expect(isExactlyOneRowWritten([{ id: "x" }, { id: "y" }])).toBe(false);
    expect(isExactlyOneRowWritten(null)).toBe(false);
    expect(isExactlyOneRowWritten(undefined)).toBe(false);
    expect(isExactlyOneRowWritten({ id: "x" })).toBe(false);
  });
});

describe("messages and module boundaries", () => {
  it("neither message names a variable, value, deployment or provider", () => {
    for (const message of [PAID_REPRICING_UNAVAILABLE_MESSAGE, CATALOG_ROW_CHANGED_MESSAGE]) {
      for (const leak of ["PAID_", "controlled_staging", "preview", "staging", "POK", "Stripe", "VERCEL", "env"]) {
        expect(message).not.toContain(leak);
      }
    }
  });

  it("the rule reads no environment and never names price_cents", () => {
    const source = readFileSync(fileURLToPath(new URL("./paid-repricing.ts", import.meta.url)), "utf8");
    const code = source.replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("process.env");
    expect(code).not.toContain("price_cents");
  });

  it("updateBook and updateBundle both use this one rule, and neither selects price_cents for it", () => {
    for (const path of [
      "../app/(public)/dashboard/books/actions.ts",
      "../app/(public)/dashboard/bundles/actions.ts",
    ]) {
      const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
      expect(source).toContain("resolvePriceUpdateAuthorization(");
      expect(source).toContain("applyCatalogRowGuard(");
      expect(source).toContain("isExactlyOneRowWritten(");
      const code = source.replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/\.select\([^)]*price_cents/);
      expect(code).not.toMatch(/\.price_cents\b/);
    }
  });
});
