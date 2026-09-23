import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ALL-WIRING-2: the storefront-wide properties of Patch 2.
//
// WHAT THIS FILE IS, AND WHAT IT IS NOT -- stated plainly, because a
// source scan that presents itself as a render test is worse than no
// test at all.
//
// Every surface below is an async React Server Component that queries
// Supabase during render. An earlier version of this comment claimed
// such a surface CANNOT be rendered under this test setup. That was
// WRONG, and the correction matters more than the claim did: this
// repository renders Server Components in 18 test files already, with
// renderToStaticMarkup from react-dom/server and a stubbed Supabase
// client, no DOM library and no jsdom environment -- see
// ./books/[id]/page.test.ts, which this same patch extends. Rendering
// is available here; it needs no new dependency.
//
// So the limitation below is a CHOICE OF THIS FILE, not a property of
// the repository. Rendering each of these surfaces needs a query-builder
// stub shaped to that surface's own chain, and this patch's rendered
// budget went to the book detail page, where the reader-visible
// acquisition decision lives. Nothing here claims to have rendered a
// surface, and no absence of a rendered test here should be read as
// evidence that one was impossible.
//
// What each assertion below actually establishes is a STRUCTURAL fact
// about the committed source: which column a query filters on, which
// formatter a surface calls, and which branch precedes which. That is
// genuine evidence -- a `.not("price_all", "is", null)` either is in
// the query builder chain or is not -- but it is weaker than a render
// in one particular way: it cannot prove the branch it finds is the
// branch that executes. The DECISIONS those branches
// consume are separately and properly unit-tested as pure functions
// (src/lib/book-purchase.test.ts, src/lib/catalog-price.test.ts), and
// the search path is tested against a real PostgreSQL 17 instance
// (supabase/tests/063_all_search_books_price_all.test.sql). Read the
// three together.
//
// Comments are stripped before every negative scan. A file that
// DOCUMENTS why it no longer uses price_cents would otherwise fail its
// own check -- the same trap the SQL harness's prosrc probes avoid.

const ROOT = new URL("./", import.meta.url);

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, ROOT)), "utf8");
}

/** Source with // line comments, block comments and JSX comments removed. */
function code(source: string): string {
  return source
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// The surfaces that DISCOVER books -- a reader arrives at them without
// having asked for any particular title, so a book with no authored ALL
// price must not be among the ones offered.
const DISCOVERY_SURFACES: Array<[string, string]> = [
  ["the bookstore grid", "bookstore/page.tsx"],
  ["the homepage", "page.tsx"],
  ["an author's page", "authors/[id]/page.tsx"],
  ["a series page", "series/[id]/page.tsx"],
  ["book detail's recommendation rails", "books/[id]/page.tsx"],
];

// The surfaces that deliberately KEEP an unpriced row, each for a
// stated reason. Listed here so the exclusion cannot spread to them by
// accident, and so the reasons stay written down.
const RETAINED_SURFACES: Array<[string, string, string]> = [
  [
    "the reader's own wishlist",
    "wishlist/page.tsx",
    "a reader's saved list is theirs; silently removing a book they saved is a worse answer than showing it as unavailable",
  ],
  [
    "a bundle's contents",
    "bundles/[id]/page.tsx",
    "a bundle's membership is its composition -- hiding a member misrepresents what the bundle is, and bundle checkout is unconditionally closed anyway",
  ],
];

describe("null-priced books are excluded from every discovery surface", () => {
  it.each(DISCOVERY_SURFACES)("%s filters out rows with no authored ALL price", (_label, file) => {
    const source = code(read(file));
    expect(source).toContain('.not("price_all", "is", null)');
  });

  it("book detail excludes them from ALL THREE of its rails, not just one", () => {
    // series neighbours, more-by-author, and you-might-like. One rail
    // left unfiltered would keep surfacing unbuyable books from the
    // page of a book the reader is already looking at.
    const source = code(read("books/[id]/page.tsx"));
    const occurrences = source.split('.not("price_all", "is", null)').length - 1;
    expect(occurrences).toBe(3);
  });

  it("the bookstore's price RANGE filter is applied to price_all, not price_cents", () => {
    const source = code(read("bookstore/page.tsx"));
    expect(source).toContain('.gte("price_all"');
    expect(source).toContain('.lte("price_all"');
    expect(source).not.toContain('.gte("price_cents"');
    expect(source).not.toContain('.lte("price_cents"');
  });

  it("the bookstore's price SORT reads price_all", () => {
    const source = code(read("bookstore/page.tsx"));
    expect(source).toMatch(/price_all\s*\?\?\s*0/);
    expect(source).not.toMatch(/a\.price_cents|b\.price_cents/);
  });

  // The searched path of the same page delegates to SQL, so the
  // exclusion there lives in the migration and is proved by
  // supabase/tests/063_all_search_books_price_all.test.sql against a
  // real server. What IS checkable from here is that the page still
  // calls that function and still passes the unrenamed parameters.
  it("the searched path still calls search_books with its original parameter names", () => {
    const source = code(read("bookstore/page.tsx"));
    expect(source).toContain("search_books");
    expect(source).toContain("min_price_cents");
    expect(source).toContain("max_price_cents");
  });
});

describe("the surfaces that deliberately keep an unpriced row", () => {
  it.each(RETAINED_SURFACES)("%s keeps it: %s", (_label, file, _reason) => {
    const source = code(read(file));
    expect(source).not.toContain('.not("price_all", "is", null)');
  });

  it("each of them says so in its own source, so the omission is not read as an oversight", () => {
    for (const [, file] of RETAINED_SURFACES) {
      // The RAW source, comments included -- the comment is the subject.
      expect(read(file)).toMatch(/ALL-WIRING-2/);
    }
  });
});

describe("no active book surface renders a dollar sign or a legacy USD formatter", () => {
  const BOOK_SURFACES = [
    "bookstore/page.tsx",
    "page.tsx",
    "authors/[id]/page.tsx",
    "series/[id]/page.tsx",
    "books/[id]/page.tsx",
    "wishlist/page.tsx",
    "dashboard/page.tsx",
    "dashboard/books/page.tsx",
    "dashboard/books/[id]/edit/page.tsx",
    "dashboard/books/new/upload-wizard.tsx",
    "../../components/book-card.tsx",
    "../../components/author-book-row.tsx",
    "../../components/earnings-calculator.tsx",
  ];

  it.each(BOOK_SURFACES)("%s contains no dollar sign outside a template literal", (file) => {
    const source = code(read(file));
    // `${...}` interpolation and regex anchors are not currency.
    const stripped = source
      .replace(/\$\{/g, "")
      .replace(/\$\/|\$"|\$'|\$\)|\$\||\$i/g, "");
    expect(stripped).not.toContain("$");
  });

  it("no BOOK price anywhere goes through the legacy USD formatters", () => {
    for (const file of BOOK_SURFACES) {
      const source = code(read(file));
      // ALL-WIRING-5: formatPrice no longer exists at all (its last
      // callers were the bundle rails), so there is no exemption left.
      const bookPriceThroughLegacy = source.match(/format(?:All)?Price\(/g);
      expect(bookPriceThroughLegacy).toBeNull();
    }
  });

  it("no surface branches on an environment variable to choose a book's displayed currency", () => {
    for (const file of BOOK_SURFACES) {
      const source = code(read(file));
      expect(source).not.toMatch(/usePok\s*\?[^:]*format/);
      expect(source).not.toMatch(/process\.env[^\n]*\?[^\n]*format(?:All)?Price/);
    }
  });

  it("the book card and the author row both render the one catalog label", () => {
    for (const file of ["../../components/book-card.tsx", "../../components/author-book-row.tsx"]) {
      const source = code(read(file));
      expect(source).toContain("formatCatalogPriceLabel(book.price_all)");
      expect(source).not.toContain("price_cents");
    }
  });
});

describe("bundle pricing moved to price_all in Patch 5 (ALL-WIRING-5)", () => {
  // Patch 2's scope stopped at books and this block used to pin bundles
  // to `formatPrice(bundle.price_cents)` so a "remove formatPrice"
  // sweep could not take them along by accident. Patch 5 is that move,
  // done deliberately; these assertions now pin the NEW state, and
  // ./all-wiring-bundles.test.ts carries the full bundle guard.
  it.each([
    ["the bookstore's bundle rail", "bookstore/page.tsx"],
    ["an author's bundle rail", "authors/[id]/page.tsx"],
  ])("%s prices bundles from bundle.price_all via the catalog label", (_label, file) => {
    const source = code(read(file));
    expect(source).toContain("formatCatalogPriceLabel(bundle.price_all)");
    expect(source).not.toContain("formatPrice(bundle.price_cents)");
  });

  it("bundle detail reads the bundle's own price from price_all, without filtering its members on it", () => {
    const source = code(read("bundles/[id]/page.tsx"));
    expect(source).not.toContain('.not("price_all", "is", null)');
    expect(source).toContain("formatCatalogPriceLabel(bundle.price_all)");
  });

  it("buyBundle is still unconditionally closed, and is not given a price_all path", () => {
    const source = code(read("bundles/[id]/actions.ts"));
    expect(source).not.toContain("price_all");
    expect(source).not.toContain("PAID_CHECKOUT_MODE");
    expect(source).not.toContain("canStartPaidCheckout");
  });

  // ALL-TXN-CURRENCY-4: Patch 4 moved it. The frozen intent amount now
  // renders in the intent's OWN stored currency through the shared
  // transaction formatter -- no longer "ALL, else assume dollars".
  it("the held-quote notice renders the frozen amount in the intent's own currency (Patch 4)", () => {
    const source = code(read("books/[id]/page.tsx"));
    expect(source).toContain("formatTransactionAmount(");
    expect(source).toContain("provenanceFromStoredCurrency(heldQuote.currency)");
    expect(source).not.toContain("formatAllPrice(");
    expect(source).not.toContain("formatPrice(heldQuote");
  });
});

describe("book detail: an unpriced book offers no way to acquire it", () => {
  const source = read("books/[id]/page.tsx");
  const stripped = code(source);

  // The two unavailable states exist and are handled in PurchasePanel.
  it("PurchasePanel handles both unavailable states explicitly", () => {
    expect(stripped).toContain('state === "anonymous-unavailable"');
    expect(stripped).toContain('state === "unavailable-unowned"');
  });

  // ORDER is the property: both unavailable branches must return before
  // any branch that renders an acquisition control, so no later ternary
  // can fall through into a buy or free-download form.
  it("both unavailable branches precede every acquisition control in the panel", () => {
    const panelStart = stripped.indexOf("function PurchasePanel(");
    expect(panelStart).toBeGreaterThan(-1);
    const panel = stripped.slice(panelStart);

    const anonUnavailable = panel.indexOf('state === "anonymous-unavailable"');
    const unownedUnavailable = panel.indexOf('state === "unavailable-unowned"');
    expect(anonUnavailable).toBeGreaterThan(-1);
    expect(unownedUnavailable).toBeGreaterThan(-1);

    // Every acquisition control the panel can render.
    const acquisitionMarkers = ["buyBook", "getFreeBook", "/login?next="];
    for (const marker of acquisitionMarkers) {
      const firstUse = panel.indexOf(marker);
      if (firstUse === -1) continue;
      expect(firstUse).toBeGreaterThan(anonUnavailable);
      expect(firstUse).toBeGreaterThan(unownedUnavailable);
    }
  });

  it("the unavailable branches themselves contain no acquisition control", () => {
    const panelStart = stripped.indexOf("function PurchasePanel(");
    const panel = stripped.slice(panelStart);
    const start = panel.indexOf('state === "anonymous-unavailable"');
    // Up to the first branch that is NOT one of the two unavailable ones.
    const end = panel.indexOf("state ===", panel.indexOf('state === "unavailable-unowned"') + 1);
    const region = end === -1 ? panel.slice(start) : panel.slice(start, end);
    expect(region.length).toBeGreaterThan(100);
    for (const marker of ["buyBook", "getFreeBook", "/login?next=", "Buy", "Get this book"]) {
      expect(region).not.toContain(marker);
    }
  });

  it("the page's price line goes through the catalog label, so it reads Price unavailable", () => {
    expect(stripped).toContain("formatCatalogPriceLabel(book.price_all)");
  });

  it("the purchase state is resolved from price_all, never from price_cents", () => {
    expect(stripped).toMatch(/priceAll:\s*book\.price_all/);
    expect(stripped).not.toMatch(/priceCents:\s*book\.price_cents/);
  });

  it("an unpriced book's page is still REACHABLE -- nothing 404s or unpublishes it", () => {
    // The detail query must not filter on price_all: excluding the row
    // here would turn "unavailable" into "gone", and would also break
    // the link an owner follows to their own download.
    const detailQuery = stripped.slice(0, stripped.indexOf("function PurchasePanel("));
    // `.single<BookWithAuthorBio>()`, not a bare `.single()`.
    const bookFetch = detailQuery.match(/from\("books"\)[\s\S]{0,400}?\.single[<(]/);
    expect(bookFetch).not.toBeNull();
    expect(bookFetch?.[0]).not.toContain("price_all");
  });
});
