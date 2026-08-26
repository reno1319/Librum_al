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

export type ParsedBookstoreQuery = {
  q?: string;
  genre?: string;
  sort?: string;
  minPriceCents?: number;
  maxPriceCents?: number;
  isFiltered: boolean;
};

// Dollar-string price params -> integer cents, the same rounding
// Stripe-facing code elsewhere in this codebase already uses. A
// non-numeric or empty value simply yields "no filter" rather than an
// error -- these are optional GET params a reader could hand-edit in
// the URL.
function parsePriceCents(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const dollars = Number(value);
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : undefined;
}

export function parseBookstoreQuery(params: BookstoreQuery): ParsedBookstoreQuery {
  const { q, genre, sort, minPrice, maxPrice } = params;
  const minPriceCents = parsePriceCents(minPrice);
  const maxPriceCents = parsePriceCents(maxPrice);

  return {
    q,
    genre,
    sort,
    minPriceCents,
    maxPriceCents,
    isFiltered: Boolean(
      q?.trim() || genre || sort || minPriceCents != null || maxPriceCents != null,
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
