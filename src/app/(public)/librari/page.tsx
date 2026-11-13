import Link from "next/link";
import { AdultTag } from "@/components/adult-tag";
import { bundleIsAdult } from "@/lib/book-reader-details";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatCatalogPriceLabel, resolveCatalogPriceState } from "@/lib/catalog-price";
import {
  parseBookstoreQuery,
  buildBookstoreHref,
  BOOKSTORE_SORT_OPTIONS,
  type BookstoreQuery,
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
import { GENRES } from "@/lib/genres";
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
  const [{ books, error, totalMatched }, bundles, freeBooks, signedIn, librumChoice] = await Promise.all([
    fetchSearchResults(supabase, { q, genre, sort, minPriceAll, maxPriceAll }),
    isFiltered ? Promise.resolve([]) : fetchPublishedBundles(supabase),
    isFiltered ? Promise.resolve([]) : fetchFreeBooks(supabase),
    isFiltered
      ? Promise.resolve(false)
      : supabase.auth.getUser().then(({ data }) => !!data.user),
    isFiltered ? Promise.resolve(null) : getLibrumChoiceBook(),
  ]);

  // REDESIGN STEP 3 / F5 (C2): the feature only on the unfiltered view
  // and never over a failed load; inside it, the priced pick as
  // "Librum's choice", else the newest book as "New on Librum".
  const showShelves = !isFiltered && !error && books.length > 0;
  const featured = showShelves ? resolveBookstoreFeature<BookWithAuthor>(librumChoice, books[0]) : null;

  // P2 (design B): the big heading and the ornate shelf are gone. The
  // page is white, opens with a slim feature strip, then "Libraria · N
  // libra" with the page's own search box, genres, Sort, Price and Libra
  // falas (P2c, Renato 11-10 option b: the site header is the old one on
  // every page again, so search and genres are back inside this page),
  // then the grid. The free shelf follows the grid, then bundles and the
  // band.
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

        <BookstoreHeading
          query={{ ...rawQuery, genre }}
          countLine={error ? null : countLineFor(totalMatched)}
          hasFeature={!!featured}
        />

        <BookGrid supabase={supabase} books={books} error={error} isFiltered={isFiltered} />

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

// Patch B (Renato 11-13): a serif "Libraria" heading over one framed
// box. Row 1: the full-width search box. Row 2: the pills (Zhanret,
// Sort, Price, Libra falas) with the count on the right (its own line
// on phones). Row 3, only while a filter is on: one chip per filter,
// each removing only itself, then "Hiq të gjitha". Sort is not a
// filter, so it has no chip. Each pill keeps the
// other current filters: the search box and Sort are small GET forms
// with hidden fields (Sort sends itself on change, with a button only
// when JavaScript is off); genres and Libra falas are links.
function BookstoreHeading({
  query,
  countLine,
  hasFeature,
}: {
  query: BookstoreQuery;
  // null only when the load failed: then no count line at all.
  countLine: string | null;
  hasFeature: boolean;
}) {
  const { q, genre, sort, minPrice, maxPrice } = query;
  const words = q?.trim();

  const freeActive = maxPrice === "0" && !minPrice;

  // One chip per filter that is really applied, so the price chip reads
  // the parsed bounds (a hand-typed "abc" is ignored by the grid and gets
  // no chip). Each chip's link drops only its own filter.
  const { minPriceAll, maxPriceAll, isFiltered } = parseBookstoreQuery(query);
  const noPrice = { minPrice: undefined, maxPrice: undefined };
  const chips: { label: string; href: string }[] = [];
  if (words) chips.push({ label: `“${words}”`, href: buildBookstoreHref(query, { q: undefined }) });
  if (genre) chips.push({ label: genre, href: buildBookstoreHref(query, { genre: undefined }) });
  if (maxPriceAll === 0 && !minPriceAll) {
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

  return (
    <div className={hasFeature ? "mt-10" : "mt-1"}>
      <h1 className="font-serif text-[2rem] leading-tight font-normal text-primary sm:text-[2.25rem]">Libraria</h1>
      <div className="mt-4 rounded-[12px] border border-control bg-surface p-3 sm:p-4">
        <form id="bookstore-search" action="/librari" method="get" role="search" className="flex w-full min-w-0">
          <label htmlFor="bookstore-q" className="sr-only">
            Kërkoni libra ose autorë
          </label>
          <span className="relative flex min-w-0 flex-1">
            <svg aria-hidden="true" viewBox="0 0 20 20" className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted">
              <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="1.8" />
            </svg>
            <input
              id="bookstore-q"
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Kërkoni libra ose autorë"
              className="focus-ring h-11 min-w-0 flex-1 rounded-l-full border border-r-0 border-control bg-surface pr-4 pl-10 text-base text-foreground"
            />
          </span>
          {genre && <input type="hidden" name="genre" value={genre} />}
          {sort && <input type="hidden" name="sort" value={sort} />}
          {minPrice && <input type="hidden" name="minPrice" value={minPrice} />}
          {maxPrice && <input type="hidden" name="maxPrice" value={maxPrice} />}
          <button
            type="submit"
            className="focus-ring h-11 shrink-0 rounded-r-full bg-primary px-5 text-base font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            Kërko
          </button>
        </form>

        {/* P2d (Renato 11-10): on phones the four pills sit in two tidy rows
            of two equal pills (a 2x2 grid), all visible with no swiping;
            the count goes on its own line under them. From 640px up the
            row wraps as before. */}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:gap-2.5">
          {/* P2c: the genre list, as the old header menu had it. On phones
              it spans the page, 16px from each edge, so it never runs past
              the screen; from 640px up it hangs under the button. Each
              genre keeps the current words, sort and price. */}
          <DismissableDetails className="group text-sm sm:relative" closeOnLinkClick>
            <summary className={DROPDOWN_SUMMARY_CLASSES}>
              Zhanret
              <ChevronIcon />
            </summary>
            <nav
              aria-label="Zhanret"
              className="absolute inset-x-4 z-30 mt-2 rounded-[8px] border border-border bg-surface p-2 shadow-md sm:inset-x-auto sm:left-0 sm:w-[26rem]"
            >
              <ul className="grid gap-0.5 sm:grid-cols-2">
                <li>
                  <Link
                    href={buildBookstoreHref(query, { genre: undefined })}
                    aria-current={!genre ? "true" : undefined}
                    className={`${GENRE_LINK_CLASSES} ${!genre ? "font-semibold text-primary" : "font-medium text-foreground"}`}
                  >
                    Të gjitha zhanret
                  </Link>
                </li>
                {GENRES.map((g) => (
                  <li key={g}>
                    <Link
                      href={buildBookstoreHref(query, { genre: g })}
                      aria-current={genre === g ? "true" : undefined}
                      className={`${GENRE_LINK_CLASSES} ${genre === g ? "font-semibold text-primary" : "font-medium text-foreground"}`}
                    >
                      {g}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
          </DismissableDetails>

          <form action="/librari" method="get" className="contents">
            {q && <input type="hidden" name="q" value={q} />}
            {genre && <input type="hidden" name="genre" value={genre} />}
            {minPrice && <input type="hidden" name="minPrice" value={minPrice} />}
            {maxPrice && <input type="hidden" name="maxPrice" value={maxPrice} />}
            {/* Still a native select: the box around it (with "Sort by")
                is drawn to match the Price button beside it. */}
            <label
              htmlFor="bookstore-sort"
              className={`${FILTER_CONTROL_CLASSES} has-[select:focus-visible]:shadow-[var(--focus-ring)]`}
            >
              {/* On phones the label is for screen readers only, so Sort and
                  Price fit on one line. */}
              <span className="sr-only font-normal text-muted sm:not-sr-only">Renditni sipas</span>
              <span className="relative flex flex-1 items-center">
                <AutoSubmitSelect
                  id="bookstore-sort"
                  name="sort"
                  defaultValue={sort ?? ""}
                  className="w-full cursor-pointer appearance-none bg-transparent pr-5 font-semibold text-foreground outline-none"
                >
                  {BOOKSTORE_SORT_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </AutoSubmitSelect>
                <span className="pointer-events-none absolute right-0 flex">
                  <ChevronIcon />
                </span>
              </span>
            </label>
            <noscript>
              <button type="submit" className={buttonClasses("outline", "sm", "rounded-full")}>
                Rendit
              </button>
            </noscript>
          </form>

          {/* P2 r2: on phones the price box spans the page, 16px from each
              edge (Sort and Price now share one line, so a box hung under
              the button could run off the screen); from 640px up it hangs
              under the button, right-aligned. */}
          <DismissableDetails className="group text-sm sm:relative">
            <summary className={DROPDOWN_SUMMARY_CLASSES}>
              Çmimi (lekë)
              <ChevronIcon />
            </summary>
            <form
              action="/librari"
              method="get"
              className="absolute inset-x-4 z-20 mt-2 flex items-end gap-3 rounded-[8px] border border-border bg-surface p-3 shadow-md sm:inset-x-auto sm:right-0 sm:w-max"
            >
              {q && <input type="hidden" name="q" value={q} />}
              {genre && <input type="hidden" name="genre" value={genre} />}
              {sort && <input type="hidden" name="sort" value={sort} />}

              <div className="min-w-0 flex-1 sm:flex-none">
                <label htmlFor="bookstore-min-price" className="block text-xs text-muted">
                  Nga
                </label>
                <input
                  id="bookstore-min-price"
                  type="number"
                  name="minPrice"
                  defaultValue={minPrice ?? ""}
                  placeholder="0"
                  min="0"
                  step="1"
                  className="focus-ring w-full rounded-[8px] border border-[#8c8472] bg-surface px-2 py-1.5 text-sm sm:w-24"
                />
              </div>
              <div className="min-w-0 flex-1 sm:flex-none">
                <label htmlFor="bookstore-max-price" className="block text-xs text-muted">
                  Deri
                </label>
                <input
                  id="bookstore-max-price"
                  type="number"
                  name="maxPrice"
                  defaultValue={maxPrice ?? ""}
                  placeholder="Pa kufi"
                  min="0"
                  step="1"
                  className="focus-ring w-full rounded-[8px] border border-[#8c8472] bg-surface px-2 py-1.5 text-sm sm:w-24"
                />
              </div>
              <button type="submit" className={buttonClasses("outline", "sm", "rounded-full")}>
                Zbato
              </button>
            </form>
          </DismissableDetails>

          {/* P2c: Libra falas (the old header link) as a pill: free books,
              keeping the current words, genre and sort. P2d: when it is on,
              tapping it again switches it off (all prices, the rest kept). */}
          <Link
            href={buildBookstoreHref(
              query,
              freeActive ? { maxPrice: undefined } : { minPrice: undefined, maxPrice: "0" },
            )}
            aria-current={freeActive ? "true" : undefined}
            className={`focus-ring ${FILTER_CONTROL_CLASSES} max-sm:justify-center ${freeActive ? "border-primary bg-primary! text-primary-foreground! hover:bg-primary-hover!" : ""}`}
          >
            {/* P2d: when on, the pill is filled dark green with a tick, so
                on and off are clearly different ("!" because the shared
                pill classes already set a background and text colour). */}
            {freeActive && (
              <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3">
                <path d="M2 6.5l2.5 2.5L10 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            )}
            Libra falas
          </Link>

          {countLine && (
            <p className="col-span-2 mt-1 text-sm sm:mt-0 sm:ml-auto" aria-live="polite">
              <span className="font-semibold text-foreground">{countLine}</span>
            </p>
          )}
        </div>

        {/* r2: the row shows whenever the page counts as filtered, so a
            sort-only view still has "Hiq të gjitha". Each link's tap area
            is 44px tall (min-h-11) while the pill drawn inside stays 36px;
            -my-1 keeps the row as compact as the pills. */}
        {(chips.length > 0 || isFiltered) && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
            {chips.length > 0 && <span className="text-sm text-muted">Filtrat:</span>}
            {chips.map((c) => (
              <Link
                key={c.label}
                href={c.href}
                aria-label={`Hiq filtrin ${c.label}`}
                className="focus-ring group -my-1 inline-flex min-h-11 max-w-full min-w-0 items-center rounded-full"
              >
                <span className="inline-flex min-h-9 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-primary/10 px-3 text-sm font-semibold text-primary group-hover:bg-primary/15">
                  {/* Long words are cut with "…" so the chip stays inside the box. */}
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
        )}
      </div>
    </div>
  );
}

// V1 (V8): the one look shared by the price button and the box around
// the Sort select. iPhone step (I1b): 16px on phones, so the row stays
// matched with the 16px sort select (globals.css), 14px from 640px up.
// P2 r2 (Renato 13:43Z: "too big and squared"): slim rounded pills,
// 40px tall on phones and 34px from 640px up; the control border keeps
// its 3:1 contrast. P2c (Renato 11-10 18:01Z, option a): slimmer still,
// 36px on phones and 32px from 640px up (the search box too); the text
// stays 16px on phones so iPhone Safari does not zoom in.
const FILTER_CONTROL_CLASSES =
  "flex h-9 cursor-pointer items-center justify-between gap-1.5 rounded-full border border-control bg-surface px-3 text-base font-semibold text-foreground sm:h-8 sm:text-sm";
const GENRE_LINK_CLASSES =
  "focus-ring block rounded-[4px] px-3 py-2 text-[0.9375rem] transition-colors hover:bg-surface-hover hover:text-primary";
const DROPDOWN_SUMMARY_CLASSES = `focus-ring ${FILTER_CONTROL_CLASSES} list-none select-none [&::-webkit-details-marker]:hidden`;

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
    <section id="all-books" aria-label="Të gjithë librat" className="mt-8 scroll-mt-6">
      <ul className="grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
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
