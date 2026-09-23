// LIBRUM 2.0 UI-4: pure decision/URL-building helpers extracted from
// src/app/bookstore/page.tsx, mirroring the same "extract a pure
// function, unit-test it directly" pattern already used by
// src/lib/homepage.ts's resolveHomepageCta()/computeAuthorSharePercent()
// and src/components/site-header.tsx's buildSiteHeaderNav().

export type BookstoreSort = "" | "bestselling" | "price_asc" | "price_desc";

export const BOOKSTORE_SORT_OPTIONS: { value: BookstoreSort; label: string }[] = [
  { value: "", label: "Newest" },
  { value: "bestselling", label: "Bestselling" },
  { value: "price_asc", label: "Price: low to high" },
  { value: "price_desc", label: "Price: high to low" },
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

export function parseBookstoreQuery(params: BookstoreQuery): ParsedBookstoreQuery {
  const { q, genre, sort, minPrice, maxPrice } = params;
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

// Builds a /bookstore?... href starting from the CURRENT query params,
// with `overrides` applied on top -- an override of `undefined` removes
// that param entirely. Used by genre chips and "Clear filters" so
// switching one control (e.g. genre) never silently discards the others
// (e.g. an active search term or sort), unlike the pre-UI-4 genre grid,
// which always linked to a bare `/bookstore?genre=X`.
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
  return qs ? `/bookstore?${qs}` : "/bookstore";
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
