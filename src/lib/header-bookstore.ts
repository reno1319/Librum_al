import { buildBookstoreHref } from "@/lib/bookstore";

// P2 (design B, Renato 11-10 option a): the site header's search box and
// the cream row's Libraria links, on every public page. The header never
// reads the address's query (page-messages.sources.test.ts allows the
// address to be read only through a page's own searchParams), so on
// Libraria the PAGE adds its current genre, sort and price to the
// header's search form with form="site-search" fields
// (src/app/(public)/librari/page.tsx). Pure, unit-tested in
// src/lib/header-bookstore.test.ts.

export const BOOKSTORE_PATH = "/librari";

/** The header search form's id, which Libraria's own fields point at. */
export const SITE_SEARCH_FORM_ID = "site-search";

/** A genre in the header menu: that genre on its own. */
export function headerGenreHref(genre: string): string {
  return buildBookstoreHref({}, { genre });
}

/** "Libra falas" in the cream row: the free filter, on its own. */
export const FREE_BOOKS_HREF = buildBookstoreHref({}, { maxPrice: "0" });
