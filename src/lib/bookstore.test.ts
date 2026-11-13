import { describe, expect, it } from "vitest";
import {
  parseBookstoreQuery,
  buildBookstoreHref,
  toggleGenreHref,
  isKnownBookstoreSort,
  BOOKSTORE_SORT_OPTIONS,
  countCatalogueFacets,
  sidebarGenres,
  activePricePreset,
  togglePriceHref,
  PRICE_PRESETS,
} from "./bookstore";
import { GENRES } from "./genres";

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

  // BD15 follow-up (P8 audit N1): a genre Librum doesn't have is ignored.
  it.each([["Horor"], ["}"], ['Poezi"'], ["Poezi,Horror"], ["poezi"], [""]])(
    "an unknown genre %j is ignored: no filter, unfiltered page",
    (genre) => {
      const result = parseBookstoreQuery({ genre });
      expect(result.genre).toBeUndefined();
      expect(result.isFiltered).toBe(false);
    },
  );

  it("a repeated ?genre= (an array) is ignored", () => {
    const result = parseBookstoreQuery({ genre: ["Poezi", "Horror"] as unknown as string });
    expect(result.genre).toBeUndefined();
    expect(result.isFiltered).toBe(false);
  });

  it("an unknown genre does not drop the other filters", () => {
    const result = parseBookstoreQuery({ genre: "Horor", q: "deti" });
    expect(result.genre).toBeUndefined();
    expect(result.q).toBe("deti");
    expect(result.isFiltered).toBe(true);
  });

  it("every Librum genre is kept as is", () => {
    for (const g of GENRES) expect(parseBookstoreQuery({ genre: g }).genre).toBe(g);
  });

  it("genre alone counts as filtered", () => {
    expect(parseBookstoreQuery({ genre: "Letërsi artistike" }).isFiltered).toBe(true);
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
    expect(parseBookstoreQuery({ genre: "Letërsi artistike" }).isFiltered).toBe(true);
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
  it("bare /librari when nothing is set", () => {
    expect(buildBookstoreHref({}, {})).toBe("/librari");
  });

  it("carries forward existing params untouched", () => {
    expect(buildBookstoreHref({ q: "dante", sort: "price_asc" }, {})).toBe(
      "/librari?q=dante&sort=price_asc",
    );
  });

  it("an override adds a new param without disturbing the others", () => {
    expect(buildBookstoreHref({ q: "dante" }, { genre: "Letërsi artistike" })).toBe(
      "/librari?q=dante&genre=Let%C3%ABrsi+artistike",
    );
  });

  it("an override of undefined removes that param", () => {
    expect(buildBookstoreHref({ q: "dante", genre: "Letërsi artistike" }, { genre: undefined })).toBe(
      "/librari?q=dante",
    );
  });

  it("an override replaces an existing value for the same key", () => {
    expect(buildBookstoreHref({ genre: "Letërsi artistike" }, { genre: "Poezi" })).toBe(
      "/librari?genre=Poezi",
    );
  });
});

describe("toggleGenreHref", () => {
  it("selecting a genre with none active adds it", () => {
    expect(toggleGenreHref({}, "Letërsi artistike")).toBe("/librari?genre=Let%C3%ABrsi+artistike");
  });

  it("clicking the already-active genre clears it (toggle off)", () => {
    expect(toggleGenreHref({ genre: "Letërsi artistike" }, "Letërsi artistike")).toBe("/librari");
  });

  it("clicking a different genre switches to it", () => {
    expect(toggleGenreHref({ genre: "Letërsi artistike" }, "Poezi")).toBe("/librari?genre=Poezi");
  });

  it("preserves an active search term while toggling genre", () => {
    expect(toggleGenreHref({ q: "dante", genre: "Letërsi artistike" }, "Letërsi artistike")).toBe(
      "/librari?q=dante",
    );
  });
});

// Patch C (Renato 11-13): the sidebar's count and price rules.
describe("countCatalogueFacets", () => {
  it("counts a 2-genre book in both, a repeated category once, an unknown one not at all", () => {
    const f = countCatalogueFacets([
      { categories: ["Horror", "Poezi", "Horror"], pen: { id: "a", name: "Ana" } },
      { categories: ["Horror", "Roman"], pen: { id: "b", name: "Bora" } },
      { categories: null, pen: null },
    ]);
    expect(f.total).toBe(3);
    expect(f.genres).toEqual([
      { genre: "Horror", count: 2 },
      { genre: "Poezi", count: 1 },
    ]);
  });

  it("orders by count, then by Albanian name; counts only public pen names (null = hidden by BD14)", () => {
    const pen = (id: string, name: string) => ({ categories: [], pen: { id, name } });
    const f = countCatalogueFacets([pen("z", "Zana"), pen("c", "Çlirim"), pen("d", "Dea"), pen("z", "Zana"), { categories: [], pen: null }]);
    expect(f.authors).toEqual([
      { id: "z", name: "Zana", count: 2 },
      { id: "c", name: "Çlirim", count: 1 },
      { id: "d", name: "Dea", count: 1 },
    ]);
  });
});

describe("sidebarGenres", () => {
  const facets = { total: 2, genres: [{ genre: "Horror", count: 2 }], authors: [] };
  it("adds the active genre with 0 when it has no books", () => {
    expect(sidebarGenres(facets, "Poezi")).toEqual([{ genre: "Horror", count: 2 }, { genre: "Poezi", count: 0 }]);
    expect(sidebarGenres(facets, "Horror")).toEqual([{ genre: "Horror", count: 2 }]);
  });
  it("without counts lists every genre with no count", () => {
    expect(sidebarGenres(null, undefined)).toHaveLength(GENRES.length);
    expect(sidebarGenres(null, undefined).every((g) => g.count === null)).toBe(true);
  });
});

describe("price presets", () => {
  it("r2 price a: whole-lek bounds with no overlap and no gap: 0, 1–199, 200–399, 400+", () => {
    expect(PRICE_PRESETS.map((p) => [p.label, p.min, p.max])).toEqual([
      ["Falas", undefined, 0],
      ["Deri 199 lekë", 1, 199],
      ["200–399 lekë", 200, 399],
      ["400+ lekë", 400, undefined],
    ]);
    // Every whole price from 0 to 1000 falls in exactly one row.
    for (let price = 0; price <= 1000; price++) {
      const rows = PRICE_PRESETS.filter((p) => (p.min ?? 0) <= price && price <= (p.max ?? Infinity));
      expect(rows, String(price)).toHaveLength(1);
    }
  });
  it("activePricePreset matches the parsed bounds; min 0 counts as none; anything else is no preset", () => {
    expect(activePricePreset({ minPrice: "1", maxPrice: "199" })?.label).toBe("Deri 199 lekë");
    expect(activePricePreset({ minPrice: "0", maxPrice: "0" })?.label).toBe("Falas");
    expect(activePricePreset({ maxPrice: "0" })?.label).toBe("Falas");
    expect(activePricePreset({ minPrice: "400" })?.label).toBe("400+ lekë");
    expect(activePricePreset({ maxPrice: "199" })).toBeNull();
    expect(activePricePreset({ minPrice: "401" })).toBeNull();
    expect(activePricePreset({ minPrice: "100", maxPrice: "300" })).toBeNull();
    expect(activePricePreset({ maxPrice: "abc" })).toBeNull();
    expect(activePricePreset({})).toBeNull();
  });
  it("togglePriceHref sets a row's bounds and clears the active one, keeping the rest", () => {
    const q = { q: "x", genre: "Horror", sort: "price_asc" };
    expect(togglePriceHref(q, PRICE_PRESETS[2])).toBe("/librari?q=x&genre=Horror&sort=price_asc&minPrice=200&maxPrice=399");
    expect(togglePriceHref({ ...q, minPrice: "200", maxPrice: "399" }, PRICE_PRESETS[2])).toBe("/librari?q=x&genre=Horror&sort=price_asc");
    expect(togglePriceHref({ ...q, maxPrice: "999" }, PRICE_PRESETS[3])).toBe("/librari?q=x&genre=Horror&sort=price_asc&minPrice=400");
  });
});
