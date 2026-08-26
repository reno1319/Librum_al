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
    expect(result.minPriceCents).toBeUndefined();
    expect(result.maxPriceCents).toBeUndefined();
  });

  it("parses dollar strings into integer cents", () => {
    const result = parseBookstoreQuery({ minPrice: "4.5", maxPrice: "12" });
    expect(result.minPriceCents).toBe(450);
    expect(result.maxPriceCents).toBe(1200);
  });

  it("a non-numeric price string yields no filter rather than an error", () => {
    const result = parseBookstoreQuery({ minPrice: "not-a-number" });
    expect(result.minPriceCents).toBeUndefined();
  });

  it("an empty price string yields no filter", () => {
    const result = parseBookstoreQuery({ minPrice: "" });
    expect(result.minPriceCents).toBeUndefined();
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
