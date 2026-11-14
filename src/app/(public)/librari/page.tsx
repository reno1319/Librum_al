import Link from "next/link";
import { AdultTag } from "@/components/adult-tag";
import { bundleIsAdult } from "@/lib/book-reader-details";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCatalogPriceLabel, resolveCatalogPriceState } from "@/lib/catalog-price";
import {
  parseBookstoreQuery,
  buildBookstoreHref,
  toggleGenreHref,
  togglePriceHref,
  activePricePreset,
  countCatalogueFacets,
  sidebarGenres,
  PRICE_PRESETS,
  BOOKSTORE_SORT_OPTIONS,
  sortByAlbanianTitle,
  type BookstoreQuery,
  type CatalogueFacets,
  type FacetRow,
} from "@/lib/bookstore";
import { BookCard } from "@/components/book-card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { resolveBookByline, resolveOriginalAuthor } from "@/lib/book-byline";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { getLibrumChoiceBook } from "@/lib/librum-choice";
import { resolveBookstoreFeature } from "@/lib/librum-choice-logic";
import type { PublicBook, PublicBundle } from "@/lib/types";
import { authorPagePath, type PenNameRef } from "@/lib/pen-names";
import type { Metadata } from "next";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { DismissableDetails } from "@/components/dismissable-details";
import { AutoSubmitSelect } from "@/components/auto-submit-select";
import { LISTED_BOOK_STATUSES } from "@/lib/preorder-reader";

export const metadata: Metadata = {
  title: "Libraria",
  description: "Zbuloni libra elektronikë të pavarur nga autorë që shkruajnë shqip në Librum.",
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see V3 §3.
export const dynamic = "force-dynamic";

// LIBRUM 2.0 UI-4: this page is the READER/discovery-and-buying
// marketplace -- permanent product boundary, locked alongside UI-3:
// HOMEPAGE = AUTHORS, BOOKSTORE = READERS. No author-marketing
// sections here (that's the homepage's job); this page exists purely
// for search, genre discovery, sorting, and browsing toward book
// detail, which owns the actual purchase CTA (UI-5).
//
// Previously this page had two structurally different templates -- a
// marketing-style "curated home" (hero book, stats strip, value props,
// a 14-box genre grid) shown when unfiltered, and a flat search grid
// shown once any filter was active. UI-4 unifies these into one shell
// (header, search/genre/sort toolbar, grid, empty state) that always
// renders the same way -- the unfiltered case is just "Newest, no
// filters applied", not a separate page.

// PEN-NAMES-1 (migration 20261019184512): every byline on this page is
// the book's (or bundle's) pen name, embedded from the public_pen_names
// view as `pen` -- no account columns -- and links to /autore/<pen
// name id>.
// PEN-NAMES-2: every read on this page goes through the public views.
type BookWithAuthor = PublicBook & {
  pen: PenNameRef | null;
};
type BundleWithAuthor = Pick<PublicBundle, "id" | "title" | "price_all"> & {
  pen: PenNameRef | null;
  // REDESIGN STEP 3: member rows, for the stacked covers and the count.
  // BD15 P8: is_adult and status for the bundle's 18+ tag (bundleIsAdult).
  bundle_books?:
    | { books: (Pick<PublicBook, "cover_path" | "status"> & Pick<PublicBook, "is_adult">) | null }[]
    | null;
};
type SupabaseClient = Awaited<ReturnType<typeof createClient>>;

// Hard cap while the catalog is small -- see the Phase 6 bookstore
// audit. A real pagination UI is separate, later work; this just
// prevents an unbounded grid once the catalog grows. This is the
// VISIBLE result cap, applied after sorting -- see SEARCH_CANDIDATE_LIMIT
// below for the separate, larger concept it must not be confused with.
const SEARCH_RESULT_LIMIT = 48;

// How many matching books search_books() (or the plain newest-first
// query, when there's no search term) may return before the app sorts
// and applies SEARCH_RESULT_LIMIT. This must be large enough to cover
// every book that could plausibly match, not just the 48 eventually
// shown -- otherwise sorting (newest/price/bestselling) would silently
// run over an incomplete, arbitrary subset of the true matches instead
// of the whole matched set (see the Phase 6B-2 correction audit). Also
// doubles as the bound this same query set uses to report an honest
// "N books" / "showing the first 48" count below without a second,
// separate counting query. 500 is a bounded ceiling appropriate for
// Librum's current catalog size, not a claim that it's correct at
// arbitrary scale -- see the comment on search_books() in
// supabase/schema.sql for the full reasoning.
const SEARCH_CANDIDATE_LIMIT = 500;

// A small, fixed cap on the secondary Bundles section below the main
// grid -- bundles are a distinct product entity from books, not part
// of the filtered book search, so they're always the same "most recent
// published bundles" list regardless of the active book filters.
const BUNDLE_LIMIT = 8;

async function fetchSearchResults(
  supabase: SupabaseClient,
  {
    q,
    genre,
    sort,
    minPriceAll,
    maxPriceAll,
  }: {
    q?: string;
    genre?: string;
    sort?: string;
    minPriceAll?: number;
    maxPriceAll?: number;
  },
): Promise<{ books: BookWithAuthor[]; error: boolean; totalMatched: number }> {
  // ALL-WIRING-2: every price predicate on this page reads
  // `books.price_all`, in WHOLE LEK, and a row with no authored ALL
  // price is excluded unconditionally -- not only when a price filter
  // is active. That exclusion is the storefront half of the null rule:
  // such a book is neither free nor purchasable, so it does not belong
  // in a grid whose whole purpose is choosing something to buy. The
  // same two changes are made inside search_books() so the searched and
  // unsearched paths can never disagree about which books exist.
  const baseQuery = () => {
    let query = supabase
      .from("public_books")
      .select("*, pen:public_pen_names(id, name)")
      // BD16 P4 (D1): pre-orders are listed, with their badge.
      .in("status", LISTED_BOOK_STATUSES)
      .not("price_all", "is", null);
    // BD15 P8: a category matches a book in ANY of its (up to 3)
    // categories, not only its primary one.
    if (genre) query = query.contains("categories", [genre]);
    if (minPriceAll != null) query = query.gte("price_all", minPriceAll);
    if (maxPriceAll != null) query = query.lte("price_all", maxPriceAll);
    return query;
  };

  const term = q?.trim();
  let results: BookWithAuthor[];
  let hadError = false;

  if (!term) {
    const { data, error } = await baseQuery()
      .order("created_at", { ascending: false })
      .limit(SEARCH_CANDIDATE_LIMIT)
      .returns<BookWithAuthor[]>();
    if (error) {
      console.error("Bookstore: failed to load books:", error);
      hadError = true;
    }
    results = data ?? [];
  } else {
    // Diacritic-tolerant matching (e.g. "Kerc" finding "Kërc") needs
    // Postgres's unaccent(), which the Supabase-js query builder can't
    // express directly -- so matching itself happens server-side in the
    // search_books() RPC (see supabase/schema.sql), which returns only
    // matched book ids. This still fully respects the same genre/price/
    // published-only scoping baseQuery() applies elsewhere on this page
    // -- those filters are passed into the RPC and enforced inside it.
    // ALL-WIRING-2: the RPC's parameter NAMES still read
    // `min_price_cents`/`max_price_cents` and are deliberately not
    // renamed in this patch -- renaming a function's parameters changes
    // its call signature for every caller at once, and this patch is
    // already the atomic free/paid cutover. The VALUES they carry are
    // whole lek, matching `books.price_all`, which is what the function
    // body now compares them against. The rename is a later, separate
    // change; until then this comment is the contract.
    const { data: matches, error: searchError } = await supabase.rpc(
      "search_books",
      {
        search_term: term,
        // BD15 P8: search_books() still compares the primary genre only,
        // so the category is applied in the id re-fetch below instead
        // (any of the 3 categories), with no database change. Known
        // limit: the 500 candidate cap applies before the category.
        genre_filter: null,
        min_price_cents: minPriceAll ?? null,
        max_price_cents: maxPriceAll ?? null,
        result_limit: SEARCH_CANDIDATE_LIMIT,
      },
    );

    if (searchError) {
      console.error("Bookstore search: search_books RPC failed:", searchError);
      hadError = true;
      results = [];
    } else {
      const matchedIds = (matches as { book_id: string }[] ?? []).map(
        (row) => row.book_id,
      );

      let matchedBooks: BookWithAuthor[] = [];
      if (matchedIds.length > 0) {
        // Re-fetch full rows for the matched ids the same normal way
        // every other book listing on this page already does -- the
        // RPC only ever hands back ids, never book/profile data itself.
        let matchedQuery = supabase
          .from("public_books")
          .select("*, pen:public_pen_names(id, name)")
          .in("status", LISTED_BOOK_STATUSES)
          .not("price_all", "is", null)
          .in("id", matchedIds);
        if (genre) matchedQuery = matchedQuery.contains("categories", [genre]);
        const { data: fetchedBooks, error: fetchError } = await matchedQuery
          .returns<BookWithAuthor[]>();

        if (fetchError) {
          console.error(
            "Bookstore search: failed to load matched books:",
            fetchError,
          );
          hadError = true;
        } else {
          matchedBooks = fetchedBooks ?? [];
        }
      }

      // .in() doesn't preserve the RPC's return order, and the RPC's
      // order isn't meaningful anyway -- explicitly apply the same
      // newest-first default the no-search-term branch above uses, so
      // "Newest" stays the true default regardless of match order. The
      // sort dropdown below can still override this.
      results = [...matchedBooks].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }
  }

  // ALL-WIRING-2: price sorting reads `price_all`. Both queries above
  // exclude `price_all is null`, so `?? 0` here is unreachable in
  // practice -- it exists only so the comparator is total for the
  // TypeScript type (which is `number | null`) rather than producing
  // NaN, and never as a null-means-free fallback.
  if (sort === "price_asc") {
    results = [...results].sort((a, b) => (a.price_all ?? 0) - (b.price_all ?? 0));
  } else if (sort === "price_desc") {
    results = [...results].sort((a, b) => (b.price_all ?? 0) - (a.price_all ?? 0));
  } else if (sort === "title_asc") {
    // B2: A–Zh in Albanian alphabet order (see sortByAlbanianTitle).
    results = sortByAlbanianTitle(results);
  } else if (sort === "bestselling" && results.length > 0) {
    // Real non-refunded purchase counts for exactly the books already in
    // this result set, aggregated server-side (see bestselling_books in
    // supabase/schema.sql) rather than fetching every purchases row.
    const admin = createAdminClient();
    const { data: counts, error: countsError } = await admin.rpc(
      "bestselling_books",
      { book_ids: results.map((b) => b.id) },
    );

    if (countsError) {
      // Sort is a nice-to-have on top of an already-correct result set
      // (e.g. the migration adding this function may not be applied
      // yet) -- fail soft by leaving the existing order rather than
      // erroring the whole search.
      console.error("Bookstore search: bestselling sort unavailable:", countsError);
    } else {
      const countByBook = new Map(
        (counts as { book_id: string; purchase_count: number }[] ?? []).map(
          (row) => [row.book_id, row.purchase_count],
        ),
      );
      results = [...results].sort(
        (a, b) => Number(countByBook.get(b.id) ?? 0) - Number(countByBook.get(a.id) ?? 0),
      );
    }
  }

  // Captured before the final visible-result slice below, so the page
  // can show an honest "N books" (when we definitely have everything)
  // or "showing the first 48" (when we know there's more) without a
  // second, separate counting query -- see SEARCH_CANDIDATE_LIMIT above.
  const totalMatched = results.length;

  return { books: results.slice(0, SEARCH_RESULT_LIMIT), error: hadError, totalMatched };
}

// Patch C: the sidebar counts read the WHOLE listed catalogue -- the
// same rows the unfiltered grid lists (listed status, an ALL price) --
// never the current filtered result and not capped at
// SEARCH_CANDIDATE_LIMIT. Cost: one extra light query per Libraria
// view, two small columns per book (categories and the public pen name
// embed; the embed is null when BD14 hides the pen name). Bounded at
// FACET_SCAN_LIMIT, the Supabase API's default row cap; past it the
// counts would undercount, and a counting RPC is the follow-up. A
// failed read returns null: the lists stay, the counts go.
const FACET_SCAN_LIMIT = 1000;

async function fetchCatalogueFacets(supabase: SupabaseClient): Promise<CatalogueFacets | null> {
  const { data, error } = await supabase
    .from("public_books")
    .select("categories, pen:public_pen_names(id, name)")
    .in("status", LISTED_BOOK_STATUSES)
    .not("price_all", "is", null)
    .limit(FACET_SCAN_LIMIT)
    .returns<FacetRow[]>();
  if (error) {
    console.error("Bookstore: failed to load the sidebar counts:", error);
    return null;
  }
  return countCatalogueFacets(data ?? []);
}

// Published bundles only -- the same "published or own author" policy
// that already governs books also covers bundles (see schema.sql), but
// this is a public, unauthenticated-safe listing page, so it only ever
// asks for status = 'published' rather than relying on RLS alone to
// hide drafts. Only the fields this section actually displays are
// selected -- no description, no author_id-only internals.
//
// ALL-WIRING-5: this rail is a discovery surface, so a bundle with no
// authored ALL price is excluded here exactly as an unpriced book is
// excluded from the grid above. It stays published and stays reachable
// at its own address, which says "Price unavailable"; its author still
// sees it on their dashboard, which is where the price gets set. The
// legacy `price_cents` is neither selected nor filtered on.
//
// REDESIGN STEP 3: the same one query also embeds each bundle's member
// rows and their covers (bundle_books -> books.cover_path) for the
// stacked-cover card and its "N books" count. The count is the
// membership, as on the bundle's own page; a member this visitor cannot
// read (RLS) still counts but draws no cover.
async function fetchPublishedBundles(
  supabase: SupabaseClient,
): Promise<BundleWithAuthor[]> {
  const { data, error } = await supabase
    .from("public_bundles")
    .select(
      "id, title, price_all, pen:public_pen_names(id, name), bundle_books(books:public_books(cover_path, status, is_adult))",
    )
    .eq("status", "published")
    .not("price_all", "is", null)
    .order("created_at", { ascending: false })
    .limit(BUNDLE_LIMIT)
    .returns<BundleWithAuthor[]>();

  if (error) {
    // Same fail-soft posture as the rest of this page -- Bundles is a
    // secondary section, not core inventory, so a failure here just
    // means the section doesn't render rather than erroring the whole
    // Bookstore.
    console.error("Bookstore: failed to load published bundles:", error);
    return [];
  }

  return data ?? [];
}

// REDESIGN STEP 3: the "Free to start reading" shelf (unfiltered view
// only). Newest free books, the same published-only scoping as the
// grid; `price_all = 0` already excludes an unpriced row. Fail-soft: an
// error just hides the shelf.
async function fetchFreeBooks(supabase: SupabaseClient): Promise<BookWithAuthor[]> {
  const { data, error } = await supabase
    .from("public_books")
    .select("*, pen:public_pen_names(id, name)")
    .eq("status", "published")
    .eq("price_all", 0)
    .order("created_at", { ascending: false })
    .limit(SHELF_SIZE)
    .returns<BookWithAuthor[]>();

  if (error) {
    console.error("Bookstore: failed to load free books:", error);
    return [];
  }

  return data ?? [];
}

function coverUrlFor(supabase: SupabaseClient, coverPath: string | null | undefined) {
  return coverPath
    ? supabase.storage.from("covers").getPublicUrl(coverPath).data.publicUrl
    : null;
}

// REDESIGN STEP 3 (Renato D1/D7): the feature block shows the newest
// published book as "New on Librum". F5: or the hand-picked book as
// "Librum's choice" -- chosen, with its label, by resolveBookstoreFeature.

// Books per shelf on the unfiltered view.
const SHELF_SIZE = 6;

// A2 page heading: thin serif, as on the homepage (Renato D6).
const SECTION_HEADING = "font-serif text-[1.75rem] font-normal leading-tight text-primary sm:text-3xl";
const TEXT_LINK_CLASSES =
  "focus-ring rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2";

export default async function BookstorePage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    genre?: string;
    sort?: string;
    minPrice?: string;
    maxPrice?: string;
  }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive public discovery page (V3 §3) --
  // checked as the first statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const rawQuery = await searchParams;
  const supabase = await createClient();
  const { q, genre, sort, minPriceAll, maxPriceAll, isFiltered } =
    parseBookstoreQuery(rawQuery);

  // Bundles are a secondary discovery feature, not part of the book
  // search result set -- showing unrelated bundles below filtered book
  // results would weaken the reader's search/filter mental model, so
  // the section (and the query behind it) is skipped entirely once any
  // search/genre/sort/price filter is active. See BundlesSection's own
  // render site below for where this is enforced a second time,
  // defensively, rather than relying solely on the empty array here.
  // REDESIGN STEP 3: the free shelf follows the same rule.
  // FIX1 (X1): the author band's button depends on whether anyone is
  // signed in, so the unfiltered view (the only one with the band) asks.
  // F5: the unfiltered view also asks for Librum's choice (null when
  // nothing is picked, the pick is unpublished, or before the migration).
  // Patch C: the sidebar counts, on every view.
  const [{ books, error, totalMatched }, bundles, freeBooks, signedIn, librumChoice, facets] = await Promise.all([
    fetchSearchResults(supabase, { q, genre, sort, minPriceAll, maxPriceAll }),
    isFiltered ? Promise.resolve([]) : fetchPublishedBundles(supabase),
    isFiltered ? Promise.resolve([]) : fetchFreeBooks(supabase),
    isFiltered
      ? Promise.resolve(false)
      : supabase.auth.getUser().then(({ data }) => !!data.user),
    isFiltered ? Promise.resolve(null) : getLibrumChoiceBook(),
    fetchCatalogueFacets(supabase),
  ]);

  // REDESIGN STEP 3 / F5 (C2): the feature only on the unfiltered view
  // and never over a failed load; inside it, the priced pick as
  // "Librum's choice", else the newest book as "New on Librum".
  const showShelves = !isFiltered && !error && books.length > 0;
  const featured = showShelves ? resolveBookstoreFeature<BookWithAuthor>(librumChoice, books[0]) : null;

  // Patch C (Renato 11-13, version A, Kolibër-style): the feature strip
  // stays on top (A2 a); then a title row (serif "Libraria", the count,
  // and from lg up "Renditja" with the sort); then two columns from lg
  // up: a sidebar (search, Zhanri, Çmimi, Autorë with counts) and the
  // chips over the grid. Under lg: the search, then "Filtrat" (the same
  // lists in a panel) beside the sort, then the chips and the grid. The
  // free shelf, bundles and the band follow at full width, as before.
  const query = { ...rawQuery, genre };
  return (
    <main className="flex-1 bg-surface">
      <div className="page-container pt-5 pb-10 sm:pt-6 md:pb-12">
        {featured && (
          <FeaturedStrip
            book={featured.book}
            label={featured.label}
            coverUrl={coverUrlFor(supabase, featured.book.cover_path)}
          />
        )}

        <TitleRow query={query} countLine={error ? null : countLineFor(totalMatched)} hasFeature={!!featured} />

        <div className="mt-5 lg:mt-8 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
          <div>
            <SearchBox query={query} />
            <nav aria-label="Filtrat" className="mt-6 hidden lg:block">
              <FilterLists query={query} facets={facets} />
            </nav>
          </div>

          <div className="min-w-0">
            <div className="mt-3 grid grid-cols-2 gap-2 lg:hidden">
              {/* r2 (audit B1): a tap on a filter closes the panel, so the
                  new results are not hidden under it. */}
              <DismissableDetails className="group" closeOnLinkClick>
                <summary className={`${DROPDOWN_SUMMARY_CLASSES} justify-center`}>
                  Filtrat
                  <ChevronIcon />
                </summary>
                <nav
                  aria-label="Filtrat"
                  className="absolute inset-x-4 z-30 mt-2 max-h-[70vh] overflow-y-auto rounded-[8px] border border-border bg-surface p-4 shadow-md"
                >
                  <FilterLists query={query} facets={facets} />
                </nav>
              </DismissableDetails>
              <SortForm query={query} id="bookstore-sort-phone" />
            </div>

            <FilterChips query={query} />

            <BookGrid supabase={supabase} books={books} error={error} isFiltered={isFiltered} />
          </div>
        </div>

        {freeBooks.length > 0 && (
          <CoverShelf
            heading="Libra falas"
            seeAllHref={buildBookstoreHref({}, { maxPrice: "0" })}
            books={freeBooks}
            supabase={supabase}
          />
        )}

        {!isFiltered && bundles.length > 0 && <BundlesSection bundles={bundles} supabase={supabase} />}

        {!isFiltered && <AuthorBand signedIn={signedIn} />}
      </div>
    </main>
  );
}

// The grid's count: every match when it fits, else the visible cap.
function countLineFor(totalMatched: number): string {
  return totalMatched <= SEARCH_RESULT_LIMIT
    ? `${totalMatched} ${totalMatched === 1 ? "libër" : "libra"}`
    : `Po shfaqen ${SEARCH_RESULT_LIMIT} librat e parë`;
}

// Patch C: the title row. The count sits on the right at every width
// (none after a failed load); "Renditja" and the sort join it from lg up.
function TitleRow({
  query,
  countLine,
  hasFeature,
}: {
  query: BookstoreQuery;
  countLine: string | null;
  hasFeature: boolean;
}) {
  return (
    <div className={`${hasFeature ? "mt-10" : "mt-1"} flex items-end justify-between gap-6 border-b border-border pb-4`}>
      <h1 className="font-serif text-[2.5rem] leading-none font-normal text-primary sm:text-[3.25rem]">Libraria</h1>
      <div className="flex items-center gap-4">
        {countLine && (
          <p className="text-base whitespace-nowrap text-muted" aria-live="polite">
            <span>{countLine}</span>
          </p>
        )}
        <div className="hidden items-center gap-3 lg:flex">
          <label htmlFor="bookstore-sort" className="text-base text-muted">
            Renditja
          </label>
          <div className="w-56">
            <SortForm query={query} id="bookstore-sort" />
          </div>
        </div>
      </div>
    </div>
  );
}

// The sort: its own small GET form keeping the words, genre and price.
// It sends itself on change; "Rendit" shows only without JavaScript.
// The title row's copy has a visible "Renditja" label; the phone copy
// has a screen-reader one.
function SortForm({ query, id }: { query: BookstoreQuery; id: string }) {
  const { q, genre, sort, minPrice, maxPrice } = query;
  const visibleLabel = id === "bookstore-sort";
  return (
    <form action="/librari" method="get" className="flex gap-2">
      {q && <input type="hidden" name="q" value={q} />}
      {genre && <input type="hidden" name="genre" value={genre} />}
      {minPrice && <input type="hidden" name="minPrice" value={minPrice} />}
      {maxPrice && <input type="hidden" name="maxPrice" value={maxPrice} />}
      {/* r2 (audit N2): the select fills the whole 44px pill, so a tap
          anywhere on it opens the list. */}
      <span className="relative flex h-11 min-w-0 flex-1 items-center rounded-full border border-control bg-surface has-[select:focus-visible]:shadow-[var(--focus-ring)]">
        {!visibleLabel && (
          <label htmlFor={id} className="sr-only">
            Renditja
          </label>
        )}
        <AutoSubmitSelect
          id={id}
          name="sort"
          defaultValue={sort ?? ""}
          className="h-full w-full min-w-0 cursor-pointer appearance-none truncate rounded-full bg-transparent pr-10 pl-4 text-base font-medium text-foreground outline-none"
        >
          {BOOKSTORE_SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </AutoSubmitSelect>
        <span className="pointer-events-none absolute right-4 flex">
          <ChevronIcon />
        </span>
      </span>
      <noscript>
        <button type="submit" className={`${buttonClasses("outline", "sm", "rounded-full")} h-11`}>
          Rendit
        </button>
      </noscript>
    </form>
  );
}

// Patch C: a cream pill with a round search button inside. It keeps the
// genre, sort and price; 16px text so iPhone Safari does not zoom in.
function SearchBox({ query }: { query: BookstoreQuery }) {
  const { q, genre, sort, minPrice, maxPrice } = query;
  return (
    <form id="bookstore-search" action="/librari" method="get" role="search" className="relative flex">
      <label htmlFor="bookstore-q" className="sr-only">
        Kërkoni libra ose autorë
      </label>
      <input
        id="bookstore-q"
        type="search"
        name="q"
        defaultValue={q ?? ""}
        placeholder="Kërkoni libra, autorë…"
        className="focus-ring h-11 w-full min-w-0 rounded-full border-0 bg-[#f1eee6] pr-12 pl-5 text-base text-foreground"
      />
      {genre && <input type="hidden" name="genre" value={genre} />}
      {sort && <input type="hidden" name="sort" value={sort} />}
      {minPrice && <input type="hidden" name="minPrice" value={minPrice} />}
      {maxPrice && <input type="hidden" name="maxPrice" value={maxPrice} />}
      {/* r2 (audit N1): a 44px tap area around the 36px green circle. */}
      <button
        type="submit"
        aria-label="Kërko"
        className="focus-ring group absolute top-0 right-0 flex size-11 items-center justify-center rounded-full"
      >
        <span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors group-hover:bg-primary-hover">
          <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4">
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="2" />
          </svg>
        </span>
      </button>
    </form>
  );
}

// Each list row is a 44px tap target; the active row is cream and bold
// green, and tapping it again clears it.
const SIDEBAR_ROW =
  "focus-ring flex min-h-11 items-center justify-between gap-3 rounded-[6px] px-3 text-[15px] transition-colors hover:bg-[#f1eee6]";
const sidebarRow = (active: boolean) =>
  `${SIDEBAR_ROW} ${active ? "bg-[#f1eee6] font-semibold text-primary" : "text-foreground"}`;
const SIDEBAR_HEADING = "mb-2 text-base font-semibold text-foreground";
// How many authors show before "Shiko të gjithë" (A1 a: the rest open
// in place, no separate page).
const SIDEBAR_AUTHORS = 6;

function Count({ n }: { n: number | null }) {
  return n == null ? null : <span className="shrink-0 font-normal text-muted tabular-nums">{n}</span>;
}

// Zhanri, Çmimi and Autorë. The counts cover the whole listed catalogue
// (fetchCatalogueFacets); when they failed to load (facets null) the
// genre and price rows stay, without counts, and Autorë is left out.
function FilterLists({ query, facets }: { query: BookstoreQuery; facets: CatalogueFacets | null }) {
  const genres = sidebarGenres(facets, query.genre);
  const preset = activePricePreset(query);
  const authors = facets?.authors ?? [];
  const shown = authors.slice(0, SIDEBAR_AUTHORS);
  const more = authors.slice(SIDEBAR_AUTHORS);
  const authorRow = (a: { id: string; name: string; count: number }) => (
    <li key={a.id}>
      <Link href={authorPagePath(a.id)} className={sidebarRow(false)}>
        <span className="min-w-0">{a.name}</span>
        <Count n={a.count} />
      </Link>
    </li>
  );

  return (
    <div className="flex flex-col gap-7">
      <section>
        <h2 className={SIDEBAR_HEADING}>Zhanri</h2>
        <ul>
          <li>
            <Link
              href={buildBookstoreHref(query, { genre: undefined })}
              aria-current={!query.genre ? "true" : undefined}
              className={sidebarRow(!query.genre)}
            >
              <span className="min-w-0">Të gjitha</span>
              <Count n={facets?.total ?? null} />
            </Link>
          </li>
          {genres.map(({ genre: g, count }) => (
            <li key={g}>
              <Link
                href={toggleGenreHref(query, g)}
                aria-current={query.genre === g ? "true" : undefined}
                className={sidebarRow(query.genre === g)}
              >
                <span className="min-w-0">{g}</span>
                <Count n={count} />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className={SIDEBAR_HEADING}>Çmimi</h2>
        <ul>
          {PRICE_PRESETS.map((p) => (
            <li key={p.label}>
              <Link
                href={togglePriceHref(query, p)}
                aria-current={preset === p ? "true" : undefined}
                className={sidebarRow(preset === p)}
              >
                {p.label}
              </Link>
            </li>
          ))}
        </ul>
      </section>

      {shown.length > 0 && (
        <section>
          <h2 className={SIDEBAR_HEADING}>Autorë</h2>
          <ul>{shown.map(authorRow)}</ul>
          {more.length > 0 && (
            // r2 (audit N4): the summary stays, so keyboard focus stays on
            // it and the list can be closed again. A named group, so the
            // open phone Filtrat panel (also a "group") does not switch it.
            <details className="group/authors">
              <summary
                className={`${TEXT_LINK_CLASSES} ml-3 inline-flex min-h-11 list-none items-center text-[15px]! [&::-webkit-details-marker]:hidden`}
              >
                <span className="group-open/authors:hidden">Shiko të gjithë</span>
                <span className="hidden group-open/authors:inline">Shiko më pak</span>
              </summary>
              <ul>{more.map(authorRow)}</ul>
            </details>
          )}
        </section>
      )}
    </div>
  );
}

// Patch B's chips (Renato 11-13), now over the grid: one per filter
// that is really applied, each removing only itself, then "Hiq të
// gjitha"; a sort-only view has "Hiq të gjitha" alone. Each link's tap
// area is 44px tall around a 36px pill. A price that equals a sidebar
// row reads as that row.
function FilterChips({ query }: { query: BookstoreQuery }) {
  const { q, genre } = query;
  const words = q?.trim();
  const { minPriceAll, maxPriceAll, isFiltered } = parseBookstoreQuery(query);
  const preset = activePricePreset(query);
  const noPrice = { minPrice: undefined, maxPrice: undefined };
  const chips: { label: string; href: string }[] = [];
  if (words) chips.push({ label: `“${words}”`, href: buildBookstoreHref(query, { q: undefined }) });
  if (genre) chips.push({ label: genre, href: buildBookstoreHref(query, { genre: undefined }) });
  if (preset) {
    chips.push({ label: preset.label, href: buildBookstoreHref(query, noPrice) });
  } else if (maxPriceAll === 0 && !minPriceAll) {
    chips.push({ label: "Falas", href: buildBookstoreHref(query, noPrice) });
  } else if (minPriceAll != null || maxPriceAll != null) {
    // r2: an open-ended range reads "Nga X lekë" / "Deri X lekë".
    const label =
      minPriceAll != null && maxPriceAll != null
        ? `Çmimi: ${minPriceAll}–${maxPriceAll} lekë`
        : minPriceAll != null
          ? `Nga ${minPriceAll} lekë`
          : `Deri ${maxPriceAll} lekë`;
    chips.push({ label, href: buildBookstoreHref(query, noPrice) });
  }
  if (chips.length === 0 && !isFiltered) return null;

  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 lg:mt-0 lg:mb-6">
      {chips.map((c) => (
        <Link
          key={c.label}
          href={c.href}
          aria-label={`Hiq filtrin ${c.label}`}
          className="focus-ring group -my-1 inline-flex min-h-11 max-w-full min-w-0 items-center rounded-full"
        >
          <span className="inline-flex min-h-9 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-primary/10 px-3 text-sm font-semibold text-primary group-hover:bg-primary/15">
            {/* Long words are cut with "…" so the chip stays in the column. */}
            <span className="min-w-0 truncate">{c.label}</span>
            <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 shrink-0">
              <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </span>
        </Link>
      ))}
      <Link href="/librari" className={`${TEXT_LINK_CLASSES} -my-1 inline-flex min-h-11 items-center ${chips.length > 0 ? "ml-1" : ""}`}>
        Hiq të gjitha
      </Link>
    </div>
  );
}

// The phone "Filtrat" button: a 44px pill, the same look as the sort
// beside it. 16px text so the row matches the 16px select.
const DROPDOWN_SUMMARY_CLASSES =
  "focus-ring flex h-11 cursor-pointer list-none items-center gap-1.5 rounded-full border border-control bg-surface px-4 text-base font-semibold text-foreground select-none [&::-webkit-details-marker]:hidden";

function ChevronIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 12 12"
      className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none"
    >
      <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

// P2 (design B): the feature is one slim strip -- small cover, label,
// title, "nga <author> · <genre>", the price and one "Shiko librin"
// pill to the book's own page, which owns buying and the sample reader.
// Same byline rule as before: an original author has no Librum page, so
// it is plain text; the pen name keeps its link.
function FeaturedStrip({
  book,
  label,
  coverUrl,
}: {
  book: BookWithAuthor;
  label: string;
  coverUrl: string | null;
}) {
  const authorName = resolveBookByline(book);
  const priceLabel = formatCatalogPriceLabel(book.price_all);
  const isFree = resolveCatalogPriceState(book.price_all) === "free";

  return (
    <section
      aria-labelledby="featured-book-title"
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[12px] border border-border bg-[#fbf9f4] p-3 sm:gap-x-5 sm:px-5 sm:py-4"
    >
      <Link
        href={`/libra/${book.id}`}
        aria-hidden="true"
        tabIndex={-1}
        className="block w-14 shrink-0 sm:w-[76px]"
      >
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            className="aspect-[5/8] w-full rounded-[2px] object-contain object-bottom drop-shadow-[0_2px_6px_rgba(0,0,0,0.18)]"
          />
        ) : (
          <CoverPlaceholder
            title={book.title}
            authorName={authorName}
            className="aspect-[5/8] w-full rounded-[2px] shadow-[0_2px_6px_rgba(0,0,0,0.18)]"
          />
        )}
      </Link>

      <div className="min-w-0 flex-[1_1_11rem]">
        <p className="text-[0.8125rem] font-semibold text-[#806510]">{label}</p>
        <h2 id="featured-book-title" className="mt-0.5 font-serif text-lg leading-snug text-primary sm:mt-1 sm:text-[1.375rem]">
          <Link href={`/libra/${book.id}`} className="focus-ring rounded-sm hover:underline">
            {book.title}
          </Link>
        </h2>
        <p className="mt-0.5 text-sm text-muted">
          {authorName && book.pen && !resolveOriginalAuthor(book) && (
            <>
              nga{" "}
              <Link href={authorPagePath(book.pen.id)} className="focus-ring rounded-sm hover:underline">
                {authorName}
              </Link>
            </>
          )}
          {authorName && resolveOriginalAuthor(book) && <>nga {authorName}</>}
          {authorName && book.genre && " · "}
          {book.genre}
          {(authorName || book.genre) && " · "}
          <span className={`font-semibold ${isFree ? "text-[#2f6b4f]" : "text-foreground"}`}>{priceLabel}</span>
          {book.is_adult && (
            <>
              {" "}
              <AdultTag />
            </>
          )}
        </p>
      </div>

      <Link href={`/libra/${book.id}`} className={FEATURE_CTA_CLASSES}>
        Shiko librin
      </Link>
    </section>
  );
}

// DR1 fix 3: outlined on this light strip (gold only on dark green).
const FEATURE_CTA_CLASSES =
  "focus-ring inline-flex shrink-0 items-center justify-center rounded-full border border-primary px-4 py-2 text-sm font-semibold text-primary transition-colors hover:bg-surface-hover";

// REDESIGN STEP 3 (B2): a headed shelf of cover cards with "See all".
// One row that scrolls sideways on phones; a grid from the small
// breakpoint up.
function CoverShelf({
  heading,
  seeAllHref,
  books,
  supabase,
}: {
  heading: string;
  seeAllHref: string;
  books: BookWithAuthor[];
  supabase: SupabaseClient;
}) {
  return (
    <section className="mt-12">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className={SECTION_HEADING}>{heading}</h2>
        <Link href={seeAllHref} className={TEXT_LINK_CLASSES}>
          Shiko të gjitha
        </Link>
      </div>
      <ul className="-mx-4 mt-5 flex gap-5 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-6 sm:overflow-visible sm:px-0 sm:pb-0 md:grid-cols-4 lg:grid-cols-6">
        {books.map((book) => (
          <li key={book.id} className="w-36 shrink-0 sm:w-auto">
            <BookCard
              book={book}
              coverUrl={coverUrlFor(supabase, book.cover_path)}
              authorName={resolveBookByline(book)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// The grid alone: its count now sits in BookstoreHeading above.
function BookGrid({
  supabase,
  books,
  error,
  isFiltered,
}: {
  supabase: SupabaseClient;
  books: BookWithAuthor[];
  error: boolean;
  isFiltered: boolean;
}) {
  if (error) {
    return (
      <EmptyState
        className="mt-10"
        title="Libraria nuk u hap dot tani."
        description="Ju lutemi provoni përsëri pas pak."
      />
    );
  }

  if (books.length === 0) {
    return isFiltered ? (
      <EmptyState
        className="mt-10"
        title="Asnjë libër nuk përputhet me kërkimin tuaj."
        description="Provoni një fjalë tjetër, ose hiqni një filtër."
        action={
          <Link href="/librari" className={buttonClasses("outline", "sm")}>
            Hiq filtrat
          </Link>
        }
      />
    ) : (
      <EmptyState
        className="mt-10"
        title="Ende nuk ka libra."
        description="Kthehuni së shpejti."
        action={
          <Link href="/" className={TEXT_LINK_CLASSES}>
            Kthehuni në faqen kryesore
          </Link>
        }
      />
    );
  }

  return (
    <section id="all-books" aria-label="Të gjithë librat" className="mt-6 scroll-mt-6 lg:mt-0">
      {/* Patch C: beside the sidebar, 4 per row at md and lg, 5 at xl. */}
      <ul className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4 xl:grid-cols-5">
        {books.map((book) => (
          <li key={book.id}>
            <BookCard
              book={book}
              coverUrl={coverUrlFor(supabase, book.cover_path)}
              authorName={resolveBookByline(book)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// Up to three member covers, fanned left to right as in the mockup.
const BUNDLE_COVER_LIMIT = 3;
const BUNDLE_COVER_OFFSETS = ["left-0 top-[10px]", "left-4 top-[5px]", "left-8 top-0"];

function BundlesSection({
  bundles,
  supabase,
}: {
  bundles: BundleWithAuthor[];
  supabase: SupabaseClient;
}) {
  return (
    <section className="mt-14">
      <div className="border-b border-border pb-3">
        <h2 className={SECTION_HEADING}>Paketat</h2>
        <p className="mt-1 text-sm text-muted">Disa libra në një koleksion.</p>
      </div>
      <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {bundles.map((bundle) => {
          const members = bundle.bundle_books ?? [];
          const covers = members
            .map((m) => m.books?.cover_path ?? null)
            .slice(0, BUNDLE_COVER_LIMIT);
          const authorName = bundle.pen?.name ?? null;
          const countLabel = `${members.length} ${members.length === 1 ? "libër" : "libra"}`;
          // Offsets are taken from the right so the front cover always
          // sits in the same place however many covers there are.
          const offsets = BUNDLE_COVER_OFFSETS.slice(BUNDLE_COVER_LIMIT - Math.max(covers.length, 1));

          return (
            <li key={bundle.id}>
              <Link
                href={`/paketa/${bundle.id}`}
                className="focus-ring group flex h-full items-center gap-4 rounded-[4px] border border-border bg-surface p-[18px] transition-colors hover:bg-surface-hover"
              >
                <div aria-hidden="true" className="relative h-[110px] w-24 shrink-0">
                  {(covers.length > 0 ? covers : [null]).map((url, i) => {
                    const src = coverUrlFor(supabase, url);
                    const position = `absolute aspect-[5/8] w-16 rounded-[2px] ${offsets[i]} ${
                      i === Math.max(covers.length, 1) - 1 ? "drop-shadow-[0_4px_10px_rgba(0,0,0,0.2)]" : ""
                    }`;
                    return src ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={i} src={src} alt="" loading="lazy" decoding="async" className={`${position} object-contain object-bottom`} />
                    ) : (
                      <div key={i} className={`${position} bg-border`} />
                    );
                  })}
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-serif text-lg leading-snug group-hover:underline">
                    {bundle.title}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-2 text-[0.8125rem] text-muted">
                    <span>{authorName ? `${countLabel} · ${authorName}` : countLabel}</span>
                    {/* BD15 P8 (F1 Q1 b): 18+ when any published book in it is. */}
                    {bundleIsAdult(members) && <AdultTag />}
                  </span>
                  <span className={`font-bold ${bundle.price_all === 0 ? "text-[#2f6b4f]" : "text-primary"}`}>
                    {formatCatalogPriceLabel(bundle.price_all)}
                  </span>
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// REDESIGN STEP 3 (B3): the mockup's closing band. FIX1 (X1): a
// signed-out visitor goes to sign up with Author chosen (the same
// target as Earnings, /signup?role=author), not to log in. Anyone
// signed in keeps /dashboard/books/new, the existing author entry
// route: a reader is sent to the become-an-author step, an author
// straight to adding a book (see dashboard/layout.tsx and
// books/new/page.tsx).
function AuthorBand({ signedIn }: { signedIn: boolean }) {
  return (
    <section className="mt-16 flex flex-wrap items-center justify-between gap-5 rounded-[4px] bg-primary p-6 text-primary-foreground sm:p-8">
      <div className="flex flex-col gap-1.5">
        <h2 className="font-serif text-[1.625rem] font-normal">Jeni autor?</h2>
        <p className="text-primary-foreground/80">
          Botoni librin tuaj në Librum dhe fitoni honorar nga çdo shitje.
        </p>
      </div>
      <Link
        href={signedIn ? "/dashboard/books/new" : "/signup?role=author"}
        className="focus-ring inline-flex items-center justify-center rounded-full bg-accent px-6 py-3.5 font-semibold text-accent-foreground transition-colors hover:bg-primary-foreground"
      >
        Filloni të publikoni
      </Link>
    </section>
  );
}
