import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ALL-WIRING-5: the source-level guard for Patch 5, in the same style
// as all-wiring-storefront.test.ts (Patch 2) and
// src/lib/transaction-currency-surfaces.test.ts (Patch 4).
//
// The BEHAVIOUR is proved elsewhere, by rendering and by driving the
// actions: ./bundle-catalog.rendered.test.ts, ./dashboard/bundles/
// pricing.test.ts and publish.test.ts, ./bundles/[id]/closure.test.ts,
// and src/lib/bundle-catalog.test.ts. This file exists so a later edit
// cannot quietly put a legacy read back on a surface that one of those
// tests happens not to exercise. Comments are stripped first, so a file
// may explain what it no longer does.

const ROOT = new URL("./", import.meta.url);
function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, ROOT)), "utf8");
}
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// Every ACTIVE bundle catalog surface: author editing, publication, and
// every page or helper that shows a reader or an author a bundle price.
const ACTIVE_BUNDLE_CATALOG = [
  "dashboard/bundles/actions.ts",
  "dashboard/bundles/page.tsx",
  "dashboard/bundles/[id]/edit/page.tsx",
  "bundles/[id]/page.tsx",
  "bundles/[id]/actions.ts",
  "bookstore/page.tsx",
  "authors/[id]/page.tsx",
  "../../lib/bundle-catalog.ts",
];

// HISTORICAL bundle money, deliberately untouched by Patch 5 and
// deliberately NOT scanned for `price_cents`: each reads a value frozen
// at checkout time (bundle_checkout_snapshots.bundle_price_cents_at_
// checkout and each item's price_cents_at_checkout) or a payment's own
// amount, which is historical transaction data, not a catalog price.
// Rewriting them because the column name contains "price_cents" would
// change what already-completed purchases mean.
const HISTORICAL_EXCLUDED = [
  "../api/webhooks/stripe/route.ts",
  "library/refund-logic.ts",
  "bundles/[id]/checkout-logic.ts",
  "../../lib/email.ts",
];

describe("active bundle catalog code never reads the legacy USD price (ALL-WIRING-5)", () => {
  it.each(ACTIVE_BUNDLE_CATALOG)("%s never mentions price_cents in code", (file) => {
    const source = code(read(file));
    // The bookstore's BOOK search keeps search_books' historical
    // parameter NAMES (min_price_cents/max_price_cents), which carry
    // whole-lek values -- see all-wiring-storefront.test.ts.
    const withoutSearchParams = source.replace(/\b(min|max)_price_cents\b/g, "");
    expect(withoutSearchParams).not.toContain("price_cents");
    expect(withoutSearchParams).not.toContain("priceCents");
  });

  it.each(ACTIVE_BUNDLE_CATALOG)("%s never calls a legacy USD formatter", (file) => {
    const source = code(read(file));
    expect(source).not.toMatch(/\bformatPrice\(/);
    expect(source).not.toMatch(/\bformatAllPrice\(/);
    expect(source).not.toContain("Intl.NumberFormat");
    expect(source).not.toMatch(/\/\s*100\)?\.toFixed\(/);
  });

  it.each(ACTIVE_BUNDLE_CATALOG)("%s emits no dollar sign and no USD label", (file) => {
    const source = code(read(file));
    // `${...}` interpolation and regex anchors are not currency.
    const stripped = source.replace(/\$\{/g, "").replace(/\$\/|\$"|\$'|\$\)|\$\||\$i/g, "");
    expect(stripped).not.toContain("$");
    expect(source).not.toMatch(/\bUSD\b/);
  });

  it("formatPrice no longer exists, so it cannot be reached for again", () => {
    const pricing = code(read("../../lib/pricing.ts"));
    expect(pricing).not.toMatch(/export function formatPrice\b/);
  });

  it("no active bundle surface selects every column (so price_cents is never fetched)", () => {
    for (const file of ACTIVE_BUNDLE_CATALOG) {
      const source = code(read(file));
      const bundleSelects = source.match(/from\("bundles"\)\s*\.select\(\s*"[^"]*"/g) ?? [];
      for (const select of bundleSelects) {
        expect(select).not.toMatch(/"\*|,\s*\*/);
      }
    }
  });
});

describe("bundle prices are parsed, classified and labelled only by the catalog module (ALL-WIRING-5)", () => {
  it("createBundle and updateBundle parse with parseCatalogPriceAll and nothing else", () => {
    const source = code(read("dashboard/bundles/actions.ts"));
    expect(source.match(/parseCatalogPriceAll\(formData\.get\("price"\)\)/g)).toHaveLength(2);
    for (const forbidden of [/\bNumber\(/, /parseFloat\(/, /parseInt\(/, /Math\.round\(/, /\*\s*100\b/, /\/\s*100\b/]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it("both writes carry price_all from the parse result", () => {
    const source = code(read("dashboard/bundles/actions.ts"));
    expect(source.match(/price_all:\s*parsedPrice\.priceAll/g)).toHaveLength(2);
  });

  it("publication classifies through resolveCatalogPriceState(bundle.price_all), refusing unavailable before paid", () => {
    const source = code(read("dashboard/bundles/actions.ts"));
    const publish = source.slice(source.indexOf("async function performBundlePublish("));
    const classify = publish.indexOf("resolveCatalogPriceState(bundle.price_all)");
    const unavailable = publish.indexOf('catalogPriceState === "unavailable"');
    const paid = publish.indexOf('catalogPriceState === "paid"');
    const membership = publish.indexOf('from("bundle_books")');
    expect(classify).toBeGreaterThan(-1);
    expect(unavailable).toBeGreaterThan(classify);
    expect(paid).toBeGreaterThan(unavailable);
    expect(membership).toBeGreaterThan(paid);
    expect(publish).toContain("canPublishPaidTitle()");
    expect(publish).not.toMatch(/price_all\s*[><]=?\s*0|price_all\s*===\s*0|!bundle\.price_all/);
  });

  it("every displayed bundle price goes through formatCatalogPriceLabel(bundle.price_all)", () => {
    for (const file of [
      "dashboard/bundles/page.tsx",
      "bundles/[id]/page.tsx",
      "bookstore/page.tsx",
      "authors/[id]/page.tsx",
    ]) {
      expect(code(read(file))).toContain("formatCatalogPriceLabel(bundle.price_all)");
    }
  });

  it("both public discovery rails exclude unpriced bundles in the query", () => {
    for (const file of ["bookstore/page.tsx", "authors/[id]/page.tsx"]) {
      const source = code(read(file));
      const bundleQuery = source.slice(source.indexOf('from("bundles")'));
      const end = bundleQuery.indexOf(".order(");
      expect(bundleQuery.slice(0, end)).toContain('.not("price_all", "is", null)');
    }
  });

  it("the author's own list and the detail page deliberately do NOT exclude unpriced bundles", () => {
    for (const file of ["dashboard/bundles/page.tsx", "bundles/[id]/page.tsx", "dashboard/bundles/[id]/edit/page.tsx"]) {
      const source = code(read(file));
      const bundleQuery = source.slice(source.indexOf('from("bundles")'), source.indexOf('from("bundles")') + 400);
      expect(bundleQuery).not.toContain('.not("price_all"');
    }
  });
});

describe("bundle checkout stays unreachable (ALL-WIRING-5)", () => {
  it("no bundle file introduces a paid-checkout mode or a checkout path", () => {
    for (const file of ACTIVE_BUNDLE_CATALOG) {
      const source = code(read(file));
      expect(source).not.toContain("PAID_CHECKOUT_MODE");
      expect(source).not.toContain("canStartPaidCheckout");
      expect(source).not.toContain("create_bundle_checkout_snapshot");
      expect(source).not.toContain("startPokCheckout");
      expect(source).not.toContain("getStripe");
    }
  });

  it("the historical files this patch deliberately leaves alone still exist where the exclusion says", () => {
    for (const file of HISTORICAL_EXCLUDED) {
      expect(read(file).length).toBeGreaterThan(0);
    }
  });
});
