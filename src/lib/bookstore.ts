import { GENRES, type Genre } from "@/lib/genres";

// LIBRUM 2.0 UI-4: pure decision/URL-building helpers extracted from
// src/app/bookstore/page.tsx, mirroring the same "extract a pure
// function, unit-test it directly" pattern already used by
// src/lib/homepage.ts's resolveHomepageCta()/computeAuthorSharePercent()
// and src/components/site-header.tsx's buildSiteHeaderNav().

export type BookstoreSort = "" | "bestselling" | "price_asc" | "price_desc";

export const BOOKSTORE_SORT_OPTIONS: { value: BookstoreSort; label: string }[] = [
  { value: "", label: "Më të rejat" },
  { value: "bestselling", label: "Më të shiturat" },
  // P2d (Renato 11-10, option a): short shop words, so the half-width
  // Sort pill on phones is not cut off.
  { value: "price_asc", label: "Më të lirat" },
  { value: "price_desc", label: "Më të shtrenjtat" },
];

const KNOWN_SORTS = new Set<string>(BOOKSTORE_SORT_OPTIONS.map((o) => o.value));

// Unknown/garbage sort values already fall through to the default
// "Newest" ordering wherever sort is actually applied (see
// fetchSearchResults in page.tsx) -- this predicate exists so that
// fallback is an explicit, tested decision rather than an implicit
// "none of the ifs matched".
export function isKnownBookstoreSort(sort: string | undefined): sort is BookstoreSort {
  return sort != null && KNOWN_SORTS.has(sort);
}

export type BookstoreQuery = {
  q?: string;
  genre?: string;
  sort?: string;
  minPrice?: string;
  maxPrice?: string;
};

// ALL-WIRING-2: the bounds are WHOLE LEK, matching books.price_all --
// not cents, and not dollars. The field names say so; the `search_books`
// RPC's own parameter names still read `min_price_cents`/
// `max_price_cents` and are deliberately NOT renamed in this patch (see
// the call site in page.tsx), so this is the one place the app-side
// name and the SQL-side name differ, on purpose and in writing.
export type ParsedBookstoreQuery = {
  q?: string;
  genre?: string;
  sort?: string;
  minPriceAll?: number;
  maxPriceAll?: number;
  isFiltered: boolean;
};

// A FILTER BOUND, not a catalog price: `parseCatalogPriceAll` is
// deliberately not reused here. A reader typing 50 into "min price" is
// asking a perfectly sensible question even though 50 is not a value
// any book may be priced at, and rejecting it would silently drop the
// filter instead of applying it. So the rule is only "a whole,
// non-negative number of lek", bounded defensively.
//
// Anything else -- a decimal, a sign, an exponent, grouping
// separators, a huge payload -- yields "no filter" rather than an
// error, exactly as before: these are optional GET params a reader can
// hand-edit in the URL. What changed is that a value is no longer
// multiplied by 100 on its way to the query.
const MAX_PRICE_FILTER_INPUT_LENGTH = 16;
const WHOLE_LEK_FILTER = /^\d+$/;

function parsePriceAllFilter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PRICE_FILTER_INPUT_LENGTH) {
    return undefined;
  }
  if (!WHOLE_LEK_FILTER.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

// BD15 follow-up (P8 audit N1): only a genre Librum has filters the
// grid. Anything else in a hand-made ?genre= (an old name, a typo,
// "}" or a repeated key, which arrives as an array) is ignored, so the
// page shows every book instead of a load error.
export function knownGenre(value: unknown): Genre | undefined {
  return typeof value === "string" && (GENRES as readonly string[]).includes(value) ? (value as Genre) : undefined;
}

export function parseBookstoreQuery(params: BookstoreQuery): ParsedBookstoreQuery {
  const { q, sort, minPrice, maxPrice } = params;
  const genre = knownGenre(params.genre);
  const minPriceAll = parsePriceAllFilter(minPrice);
  const maxPriceAll = parsePriceAllFilter(maxPrice);

  return {
    q,
    genre,
    sort,
    minPriceAll,
    maxPriceAll,
    isFiltered: Boolean(
      q?.trim() || genre || sort || minPriceAll != null || maxPriceAll != null,
    ),
  };
}

const QUERY_KEYS = ["q", "genre", "sort", "minPrice", "maxPrice"] as const;

// Builds a /librari?... href starting from the CURRENT query params,
// with `overrides` applied on top -- an override of `undefined` removes
// that param entirely. Used by genre chips and "Clear filters" so
// switching one control (e.g. genre) never silently discards the others
// (e.g. an active search term or sort), unlike the pre-UI-4 genre grid,
// which always linked to a bare `/librari?genre=X`.
export function buildBookstoreHref(
  current: BookstoreQuery,
  overrides: Partial<BookstoreQuery>,
): string {
  const merged: BookstoreQuery = { ...current, ...overrides };
  const params = new URLSearchParams();

  for (const key of QUERY_KEYS) {
    const value = merged[key];
    if (value) params.set(key, value);
  }

  const qs = params.toString();
  return qs ? `/librari?${qs}` : "/librari";
}

// A genre chip toggles off when clicking the currently-active genre --
// this is the one place that "off" behavior lives, so both the chip's
// href and its active/current state read from the same source of truth
// (current.genre === genre).
export function toggleGenreHref(current: BookstoreQuery, genre: string): string {
  return buildBookstoreHref(current, {
    genre: current.genre === genre ? undefined : genre,
  });
}

// ============================================================
// Patch C (Renato 11-13, version A): the Libraria sidebar's lists.
// ============================================================

// The four price rows, in WHOLE LEK, both ends included (as the grid's
// own min/max filter reads them). r2 (Renato 11-13, "price a"): no
// overlap and no gap -- Falas is 0, "Deri 199" is 1-199, "200–399" is
// 200-399 and "400+" is 400 and up (199 is also the D3 royalty step).
export type PricePreset = { label: string; min?: number; max?: number };

export const PRICE_PRESETS: readonly PricePreset[] = [
  { label: "Falas", max: 0 },
  { label: "Deri 199 lekë", min: 1, max: 199 },
  { label: "200–399 lekë", min: 200, max: 399 },
  { label: "400+ lekë", min: 400 },
];

// The preset the current (parsed) price bounds equal, or null. A lower
// bound of 0 filters nothing, so it counts as no lower bound. A
// hand-typed range that equals no preset has no active row (its chip
// still shows).
export function activePricePreset(query: BookstoreQuery): PricePreset | null {
  const { minPriceAll, maxPriceAll } = parseBookstoreQuery(query);
  const min = minPriceAll === 0 ? undefined : minPriceAll;
  return PRICE_PRESETS.find((p) => p.min === min && p.max === maxPriceAll) ?? null;
}

// A price row's link: its bounds, keeping the words, genre and sort; the
// active row's link clears the price instead.
export function togglePriceHref(current: BookstoreQuery, preset: PricePreset): string {
  const active = activePricePreset(current) === preset;
  return buildBookstoreHref(
    current,
    active
      ? { minPrice: undefined, maxPrice: undefined }
      : { minPrice: preset.min?.toString(), maxPrice: preset.max?.toString() },
  );
}

// One listed catalogue row as the count query reads it: its categories
// and its PUBLIC pen name (the public_pen_names embed is null when the
// BD14 gate hides the pen name, so a hidden name is never counted).
export type FacetRow = {
  categories?: string[] | null;
  pen?: { id: string; name: string } | null;
};

export type CatalogueFacets = {
  total: number;
  genres: { genre: string; count: number }[];
  authors: { id: string; name: string; count: number }[];
};

const byCountThenName = <T extends { count: number }>(name: (t: T) => string) => (a: T, b: T) =>
  b.count - a.count || name(a).localeCompare(name(b), "sq");

// Counts over the WHOLE listed catalogue (never the current filtered
// result). A book in 2 categories counts in both (as the genre filter
// finds it under both); a category repeated on one book counts once;
// a category Librum has no genre for is not counted (its row could not
// filter). Authors count the books whose public pen name it is, which
// is what the author's own page lists.
export function countCatalogueFacets(rows: FacetRow[]): CatalogueFacets {
  const genres = new Map<string, number>();
  const authors = new Map<string, { id: string; name: string; count: number }>();
  for (const row of rows) {
    for (const g of new Set(row.categories ?? [])) {
      if (knownGenre(g)) genres.set(g, (genres.get(g) ?? 0) + 1);
    }
    if (row.pen) {
      const a = authors.get(row.pen.id);
      authors.set(row.pen.id, { id: row.pen.id, name: row.pen.name, count: (a?.count ?? 0) + 1 });
    }
  }
  return {
    total: rows.length,
    genres: [...genres]
      .map(([genre, count]) => ({ genre, count }))
      .sort(byCountThenName((g) => g.genre)),
    authors: [...authors.values()].sort(byCountThenName((a) => a.name)),
  };
}

// The genre rows: only genres with at least one book, by count then
// name; the active genre always shows (with 0 when it has none). When
// the counts failed (null) every genre shows, in the usual order, with
// no counts.
export function sidebarGenres(
  facets: CatalogueFacets | null,
  activeGenre: string | undefined,
): { genre: string; count: number | null }[] {
  if (!facets) return GENRES.map((genre) => ({ genre, count: null }));
  const rows: { genre: string; count: number | null }[] = [...facets.genres];
  if (activeGenre && !rows.some((r) => r.genre === activeGenre)) rows.push({ genre: activeGenre, count: 0 });
  return rows;
}
