import { describe, expect, it } from "vitest";
import {
  parseBookstoreQuery,
  buildBookstoreHref,
  toggleGenreHref,
  isKnownBookstoreSort,
  BOOKSTORE_SORT_OPTIONS,
} from "./bookstore";

describe("parseBookstoreQuery", () => {
  it("no params: unfiltered, no price bounds", () => {
    const result = parseBookstoreQuery({});
    expect(result.isFiltered).toBe(false);
    expect(result.minPriceAll).toBeUndefined();
    expect(result.maxPriceAll).toBeUndefined();
  });

  // ALL-WIRING-2: whole lek, passed through unchanged. The old parser
  // multiplied by 100 because the column was USD cents; `books.price_all`
  // is whole lek, so a bound of 12 means twelve lek, not twelve hundred
  // of anything. A `* 100` reintroduced here would make every max-price
  // filter match effectively nothing.
  it("parses whole-lek bounds without scaling them", () => {
    const result = parseBookstoreQuery({ minPrice: "99", maxPrice: "1200" });
    expect(result.minPriceAll).toBe(99);
    expect(result.maxPriceAll).toBe(1200);
  });

  it("a non-numeric price string yields no filter rather than an error", () => {
    const result = parseBookstoreQuery({ minPrice: "not-a-number" });
    expect(result.minPriceAll).toBeUndefined();
  });

  it("an empty price string yields no filter", () => {
    const result = parseBookstoreQuery({ minPrice: "" });
    expect(result.minPriceAll).toBeUndefined();
  });

  // A filter bound is not a catalog price: 50 is not a value any book
  // may be priced at, but it is a perfectly sensible thing for a reader
  // to ask for, so it is accepted rather than silently dropped.
  it("accepts a bound outside the catalog price domain", () => {
    expect(parseBookstoreQuery({ minPrice: "50" }).minPriceAll).toBe(50);
    expect(parseBookstoreQuery({ maxPrice: "0" }).maxPriceAll).toBe(0);
  });

  it("rejects fractional, signed, exponent and grouped forms rather than coercing them", () => {
    for (const bad of ["4.5", "4,5", "-1", "+1", "1e3", "1 000", "1.000", " ", "9".repeat(20)]) {
      expect(parseBookstoreQuery({ minPrice: bad }).minPriceAll).toBeUndefined();
    }
  });

  it("tolerates surrounding whitespace on an otherwise valid bound", () => {
    expect(parseBookstoreQuery({ minPrice: " 250 " }).minPriceAll).toBe(250);
  });

  it("a whitespace-only q does not count as filtered", () => {
    const result = parseBookstoreQuery({ q: "   " });
    expect(result.isFiltered).toBe(false);
  });

  it("q alone counts as filtered", () => {
    expect(parseBookstoreQuery({ q: "dante" }).isFiltered).toBe(true);
  });

  it("genre alone counts as filtered", () => {
    expect(parseBookstoreQuery({ genre: "Fiction" }).isFiltered).toBe(true);
  });

  it("sort alone counts as filtered", () => {
    expect(parseBookstoreQuery({ sort: "price_asc" }).isFiltered).toBe(true);
  });

  it("a price bound alone counts as filtered", () => {
    expect(parseBookstoreQuery({ minPrice: "1" }).isFiltered).toBe(true);
  });
});

// LIBRUM 2.0 UI-4 pre-commit correction: the Bookstore's secondary
// Bundles section is only ever shown in the default discovery state --
// this reuses the exact same isFiltered derivation tested above, so
// these assertions exist to make that specific consumer's semantics
// explicit and traceable, not to re-test isFiltered's mechanics again.
describe("isFiltered as the Bundles-visibility gate", () => {
  it("default state (newest, no filters): Bundles discovery state is allowed", () => {
    expect(parseBookstoreQuery({}).isFiltered).toBe(false);
    expect(parseBookstoreQuery({ sort: "" }).isFiltered).toBe(false);
  });

  it("an active search term hides Bundles", () => {
    expect(parseBookstoreQuery({ q: "dante" }).isFiltered).toBe(true);
  });

  it("an active genre hides Bundles", () => {
    expect(parseBookstoreQuery({ genre: "Fiction" }).isFiltered).toBe(true);
  });

  it("a non-default sort hides Bundles", () => {
    expect(parseBookstoreQuery({ sort: "bestselling" }).isFiltered).toBe(true);
    expect(parseBookstoreQuery({ sort: "price_asc" }).isFiltered).toBe(true);
    expect(parseBookstoreQuery({ sort: "price_desc" }).isFiltered).toBe(true);
  });

  it("an active price filter hides Bundles", () => {
    expect(parseBookstoreQuery({ minPrice: "5" }).isFiltered).toBe(true);
    expect(parseBookstoreQuery({ maxPrice: "20" }).isFiltered).toBe(true);
  });
});

describe("isKnownBookstoreSort", () => {
  it("accepts every value in BOOKSTORE_SORT_OPTIONS, including the empty-string default", () => {
    for (const opt of BOOKSTORE_SORT_OPTIONS) {
      expect(isKnownBookstoreSort(opt.value)).toBe(true);
    }
  });

  it("rejects an unknown sort value", () => {
    expect(isKnownBookstoreSort("popular")).toBe(false);
  });

  it("rejects undefined", () => {
    expect(isKnownBookstoreSort(undefined)).toBe(false);
  });
});

describe("buildBookstoreHref", () => {
  it("bare /bookstore when nothing is set", () => {
    expect(buildBookstoreHref({}, {})).toBe("/bookstore");
  });

  it("carries forward existing params untouched", () => {
    expect(buildBookstoreHref({ q: "dante", sort: "price_asc" }, {})).toBe(
      "/bookstore?q=dante&sort=price_asc",
    );
  });

  it("an override adds a new param without disturbing the others", () => {
    expect(buildBookstoreHref({ q: "dante" }, { genre: "Fiction" })).toBe(
      "/bookstore?q=dante&genre=Fiction",
    );
  });

  it("an override of undefined removes that param", () => {
    expect(buildBookstoreHref({ q: "dante", genre: "Fiction" }, { genre: undefined })).toBe(
      "/bookstore?q=dante",
    );
  });

  it("an override replaces an existing value for the same key", () => {
    expect(buildBookstoreHref({ genre: "Fiction" }, { genre: "Poetry" })).toBe(
      "/bookstore?genre=Poetry",
    );
  });
});

describe("toggleGenreHref", () => {
  it("selecting a genre with none active adds it", () => {
    expect(toggleGenreHref({}, "Fiction")).toBe("/bookstore?genre=Fiction");
  });

  it("clicking the already-active genre clears it (toggle off)", () => {
    expect(toggleGenreHref({ genre: "Fiction" }, "Fiction")).toBe("/bookstore");
  });

  it("clicking a different genre switches to it", () => {
    expect(toggleGenreHref({ genre: "Fiction" }, "Poetry")).toBe("/bookstore?genre=Poetry");
  });

  it("preserves an active search term while toggling genre", () => {
    expect(toggleGenreHref({ q: "dante", genre: "Fiction" }, "Fiction")).toBe(
      "/bookstore?q=dante",
    );
  });
});
