import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GENRES } from "@/lib/genres";
import { formatCatalogPriceLabel, resolveCatalogPriceState } from "@/lib/catalog-price";
import {
  parseBookstoreQuery,
  buildBookstoreHref,
  toggleGenreHref,
  BOOKSTORE_SORT_OPTIONS,
  type BookstoreQuery,
} from "@/lib/bookstore";
import { BookCard } from "@/components/book-card";
import { BookSampleReader } from "@/components/book-sample-reader";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { resolvePublicAuthorName } from "@/lib/author-name";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import type { Book, Bundle, Profile } from "@/lib/types";
import type { Metadata } from "next";
import { CoverPlaceholder } from "@/components/cover-placeholder";

export const metadata: Metadata = {
  title: "Bookstore",
  description: "Discover independent ebooks published by Albanian-language authors on Librum.",
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

// LIBRUM 2.0 AUTHOR-1B / AUTHOR-1C: the reader-facing byline resolves
// through resolvePublicAuthorName() -- never a raw display_name read.
// AUTHOR-1C moved every public author-attribution query (this file
// included) off the base `profiles` table entirely, onto the safe
// public_author_profiles VIEW (migration 045) -- aliased back to
// `profiles` in every select string below so this file's own property
// access (`book.profiles`, `bundle.profiles`) needs no further changes.
// That view physically has no display_name column, so `Pick<Profile,
// "display_name" | ...>` would be a lie about what these rows can ever
// contain -- dropped from both types below.
type BookWithAuthor = Book & {
  profiles: Pick<Profile, "public_author_name"> | null;
};
type BundleWithAuthor = Pick<Bundle, "id" | "title" | "price_all"> & {
  profiles: Pick<Profile, "public_author_name"> | null;
  // REDESIGN STEP 3: member rows, for the stacked covers and the count.
  bundle_books?: { books: Pick<Book, "cover_path"> | null }[] | null;
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
      .from("books")
      .select("*, profiles:public_author_profiles(public_author_name)")
      .eq("status", "published")
      .not("price_all", "is", null);
    if (genre) query = query.eq("genre", genre);
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
        genre_filter: genre ?? null,
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
        const { data: fetchedBooks, error: fetchError } = await supabase
          .from("books")
          .select("*, profiles:public_author_profiles(public_author_name)")
          .eq("status", "published")
          .not("price_all", "is", null)
          .in("id", matchedIds)
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
    .from("bundles")
    .select(
      "id, title, price_all, profiles:public_author_profiles(public_author_name), bundle_books(books(cover_path))",
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
    .from("books")
    .select("*, profiles:public_author_profiles(public_author_name)")
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
// published book under this label. Kept in one place so a later
// hand-picked "Librum's choice" can swap it without touching layout.
const FEATURED_BOOK_LABEL = "New on Librum";

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
  const [{ books, error, totalMatched }, bundles, freeBooks, signedIn] = await Promise.all([
    fetchSearchResults(supabase, { q, genre, sort, minPriceAll, maxPriceAll }),
    isFiltered ? Promise.resolve([]) : fetchPublishedBundles(supabase),
    isFiltered ? Promise.resolve([]) : fetchFreeBooks(supabase),
    isFiltered
      ? Promise.resolve(false)
      : supabase.auth.getUser().then(({ data }) => !!data.user),
  ]);

  // REDESIGN STEP 3: the unfiltered view leads with the newest book
  // (D1), then free books, then the full grid. A filtered view is the
  // grid alone (B4). FIX1 (X6): the second "New on Librum" shelf that
  // followed the featured book is gone (Renato 17:11Z, 5a); the
  // featured block keeps its label.
  const showShelves = !isFiltered && !error && books.length > 0;
  const featured = showShelves ? books[0] : null;

  return (
    <main className="flex-1 bg-background">
      <div className="mx-auto w-full max-w-wide px-4 py-10 sm:px-6 md:py-12">
        <BookstoreToolbar query={rawQuery} isFiltered={isFiltered} />

        {featured && (
          <FeaturedBook book={featured} coverUrl={coverUrlFor(supabase, featured.cover_path)} />
        )}

        {freeBooks.length > 0 && (
          <CoverShelf
            heading="Free to start reading"
            seeAllHref={buildBookstoreHref({}, { maxPrice: "0" })}
            books={freeBooks}
            supabase={supabase}
          />
        )}

        <BookGrid
          supabase={supabase}
          books={books}
          error={error}
          totalMatched={totalMatched}
          isFiltered={isFiltered}
        />

        {!isFiltered && bundles.length > 0 && <BundlesSection bundles={bundles} supabase={supabase} />}

        {!isFiltered && <AuthorBand signedIn={signedIn} />}
      </div>
    </main>
  );
}

// REDESIGN STEP 3 (Renato D2, "Search sample 2"): the page heading on the
// left with the search box beside it, then one ruled row holding a
// genre dropdown (r3, Renato: one button that opens the genres) and,
// on the right, Sort and the price range. The sort select stays a field of the search form (the `form` attribute)
// so it is submitted with Search exactly as before.
function BookstoreToolbar({
  query,
  isFiltered,
}: {
  query: BookstoreQuery;
  isFiltered: boolean;
}) {
  const { q, genre, sort, minPrice, maxPrice } = query;

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6">
        <div className="min-w-0 flex-[1_1_22rem]">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-primary">
            Librum Bookstore
          </p>
          <h1 className="mt-2 font-serif text-4xl font-normal leading-tight text-primary sm:text-[2.5rem]">
            Discover independent books.
          </h1>
          <p className="mt-2 text-muted">
            Books published directly by Albanian-language authors.
          </p>
        </div>

        <form
          id="bookstore-search"
          action="/bookstore"
          method="get"
          role="search"
          className="flex w-full min-w-0 flex-[1_1_28rem] sm:max-w-[35rem]"
        >
          <label htmlFor="bookstore-q" className="sr-only">
            Search books or authors
          </label>
          <input
            id="bookstore-q"
            type="search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Search books or authors"
            className="focus-ring min-w-0 flex-1 rounded-l-[3px] border border-r-0 border-[#8c8472] bg-surface px-4 py-3 text-base"
          />

          {/* A plain GET form only sends its own named fields -- these
              preserve the current genre/price selections so submitting a
              new search term (or changing sort) doesn't silently discard
              them. */}
          {genre && <input type="hidden" name="genre" value={genre} />}
          {minPrice && <input type="hidden" name="minPrice" value={minPrice} />}
          {maxPrice && <input type="hidden" name="maxPrice" value={maxPrice} />}

          <button
            type="submit"
            className="focus-ring shrink-0 rounded-r-[3px] bg-primary px-5 text-[0.9375rem] font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            Search
          </button>
        </form>
      </div>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-y border-border py-2.5">
        {/* REDESIGN STEP 3 r3 (Renato 14:21Z: "one button and when you
            click it, it opens the genres"): the button names the current
            genre, or "All genres"; the list opens under it. */}
        <details className="group relative text-sm">
          <summary className={DROPDOWN_SUMMARY_CLASSES}>
            {genre ?? "All genres"}
            <ChevronIcon />
          </summary>
          <nav
            aria-label="Genres"
            className="absolute left-0 z-20 mt-2 w-[min(26rem,calc(100vw-2rem))] rounded-[3px] border border-border bg-surface p-2 shadow-md"
          >
            <ul className="grid gap-0.5 sm:grid-cols-2">
              <li>
                <GenreLink
                  label="All genres"
                  href={buildBookstoreHref(query, { genre: undefined })}
                  active={!genre}
                />
              </li>
              {GENRES.map((g) => (
                <li key={g}>
                  <GenreLink label={g} href={toggleGenreHref(query, g)} active={genre === g} />
                </li>
              ))}
            </ul>
          </nav>
        </details>

        <div className="flex flex-wrap items-center gap-2.5">
          <label htmlFor="bookstore-sort" className="flex items-center gap-2 text-sm text-muted">
            Sort by
            <select
              id="bookstore-sort"
              name="sort"
              form="bookstore-search"
              defaultValue={sort ?? ""}
              className="focus-ring rounded-[3px] border border-[#8c8472] bg-surface px-2.5 py-2 text-sm font-semibold text-foreground"
            >
              {BOOKSTORE_SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <details className="group relative text-sm">
            <summary className={DROPDOWN_SUMMARY_CLASSES}>
              Price range (ALL)
              <ChevronIcon />
            </summary>
            <form
              action="/bookstore"
              method="get"
              className="absolute left-0 z-20 mt-2 flex w-max items-end gap-3 rounded-[3px] border border-border bg-surface p-3 shadow-md sm:right-0 sm:left-auto"
            >
              {q && <input type="hidden" name="q" value={q} />}
              {genre && <input type="hidden" name="genre" value={genre} />}
              {sort && <input type="hidden" name="sort" value={sort} />}

              <div>
                <label htmlFor="bookstore-min-price" className="block text-xs text-muted">
                  Min
                </label>
                <input
                  id="bookstore-min-price"
                  type="number"
                  name="minPrice"
                  defaultValue={minPrice ?? ""}
                  placeholder="0"
                  min="0"
                  step="1"
                  className="focus-ring w-24 rounded-[3px] border border-[#8c8472] bg-surface px-2 py-1.5 text-sm"
                />
              </div>
              <div>
                <label htmlFor="bookstore-max-price" className="block text-xs text-muted">
                  Max
                </label>
                <input
                  id="bookstore-max-price"
                  type="number"
                  name="maxPrice"
                  defaultValue={maxPrice ?? ""}
                  placeholder="Any"
                  min="0"
                  step="1"
                  className="focus-ring w-24 rounded-[3px] border border-[#8c8472] bg-surface px-2 py-1.5 text-sm"
                />
              </div>
              <button type="submit" className={buttonClasses("outline", "sm", "rounded-[3px]")}>
                Apply
              </button>
            </form>
          </details>

          {isFiltered && (
            <Link href="/bookstore" className={`${TEXT_LINK_CLASSES} ml-1`}>
              Clear filters
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}

// One genre in the dropdown list. The current genre is bold green with
// a brass bar at its left and carries aria-current; brass is a rule
// here, never text colour.
function GenreLink({
  label,
  href,
  active,
}: {
  label: string;
  href: string;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`focus-ring block rounded-[2px] border-l-[3px] px-3 py-2 text-[0.9375rem] transition-colors ${
        active
          ? "border-accent bg-surface-hover font-bold text-primary"
          : "border-transparent font-medium text-foreground hover:bg-surface-hover hover:text-primary"
      }`}
    >
      {label}
    </Link>
  );
}

const DROPDOWN_SUMMARY_CLASSES =
  "focus-ring flex cursor-pointer list-none items-center gap-1.5 rounded-[3px] border border-[#8c8472] bg-surface px-3 py-2 font-semibold select-none [&::-webkit-details-marker]:hidden";

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

// REDESIGN STEP 3 (B1): a white card with the text on the left and a
// green panel holding the large cover on the right (cover first on
// phones). The block links to the book's own page, which owns the
// purchase; "Read sample" is the same sample reader the book page uses.
function FeaturedBook({
  book,
  coverUrl,
}: {
  book: BookWithAuthor;
  coverUrl: string | null;
}) {
  const authorName = resolvePublicAuthorName(book.profiles);
  const priceState = resolveCatalogPriceState(book.price_all);
  const priceLabel = formatCatalogPriceLabel(book.price_all);

  return (
    <section
      aria-labelledby="featured-book-title"
      className="mt-8 flex flex-col-reverse overflow-hidden rounded-[4px] border border-border bg-surface md:flex-row"
    >
      <div className="flex min-w-0 flex-[1_1_24rem] flex-col justify-center gap-4 p-6 sm:p-10">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#806510]">
          {FEATURED_BOOK_LABEL}
        </p>
        <h2
          id="featured-book-title"
         
          className="font-serif text-3xl font-normal leading-tight text-primary sm:text-[2.5rem]"
        >
          <Link href={`/books/${book.id}`} className="focus-ring rounded-sm hover:underline">
            {book.title}
          </Link>
        </h2>
        <p className="text-muted">
          {authorName && (
            <>
              by{" "}
              <Link
                href={`/authors/${book.author_id}`}
                className="focus-ring rounded-sm hover:underline"
              >
                {authorName}
              </Link>
            </>
          )}
          {authorName && book.genre && " · "}
          {book.genre}
        </p>
        {book.description && (
          <p className="line-clamp-3 max-w-xl leading-relaxed text-muted">
            {book.description}
          </p>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-3">
          {priceState === "free" ? (
            <Link href={`/books/${book.id}`} className={FEATURE_CTA_CLASSES}>
              Get ebook — Free
            </Link>
          ) : (
            // Renato (r2, 14:09Z "1. b"): the mockup's Buy button, linking
            // to the book page, which owns the purchase -- shown even while
            // paid checkout is closed there.
            <Link href={`/books/${book.id}`} className={FEATURE_CTA_CLASSES}>
              Buy · {priceLabel}
            </Link>
          )}
          <BookSampleReader bookId={book.id} bookTitle={book.title} variant="text" />
        </div>
      </div>

      <div className="flex flex-[1_1_20rem] items-center justify-center bg-primary p-8 sm:p-10">
        <Link
          href={`/books/${book.id}`}
          aria-label={book.title}
          className="focus-ring block w-36 rounded-[3px] sm:w-[12.5rem]"
        >
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coverUrl}
              alt=""
              className="aspect-[2/3] w-full rounded-[3px] object-cover shadow-[0_16px_32px_rgba(0,0,0,0.4)]"
            />
          ) : (
            // On the green panel, a thin cream edge keeps the green
            // placeholder from disappearing into it.
            <CoverPlaceholder
              title={book.title}
              authorName={authorName}
              className="aspect-[2/3] w-full rounded-[3px] shadow-[0_16px_32px_rgba(0,0,0,0.4)] ring-1 ring-primary-foreground/40"
            />
          )}
        </Link>
      </div>
    </section>
  );
}

const FEATURE_CTA_CLASSES =
  "focus-ring inline-flex items-center justify-center rounded-[3px] bg-primary px-6 py-3.5 font-semibold text-primary-foreground transition-colors hover:bg-primary-hover";

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
          See all
        </Link>
      </div>
      <ul className="-mx-4 mt-5 flex gap-5 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-6 sm:overflow-visible sm:px-0 sm:pb-0 md:grid-cols-4 lg:grid-cols-6">
        {books.map((book) => (
          <li key={book.id} className="w-36 shrink-0 sm:w-auto">
            <BookCard
              book={book}
              coverUrl={coverUrlFor(supabase, book.cover_path)}
              authorName={resolvePublicAuthorName(book.profiles)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function BookGrid({
  supabase,
  books,
  error,
  totalMatched,
  isFiltered,
}: {
  supabase: SupabaseClient;
  books: BookWithAuthor[];
  error: boolean;
  totalMatched: number;
  isFiltered: boolean;
}) {
  if (error) {
    return (
      <EmptyState
        className="mt-10"
        title="We couldn't load the bookstore right now."
        description="Please try again in a moment."
      />
    );
  }

  if (books.length === 0) {
    return isFiltered ? (
      <EmptyState
        className="mt-10"
        title="No books match your search."
        action={
          <Link href="/bookstore" className={buttonClasses("outline", "sm")}>
            Clear filters
          </Link>
        }
      />
    ) : (
      <EmptyState
        className="mt-10"
        title="No books are available yet."
        description="Check back soon."
        action={
          <Link href="/" className={TEXT_LINK_CLASSES}>
            Back to Home
          </Link>
        }
      />
    );
  }

  const countLine =
    totalMatched <= SEARCH_RESULT_LIMIT
      ? `${totalMatched} ${totalMatched === 1 ? "book" : "books"}`
      : `Showing the first ${SEARCH_RESULT_LIMIT} books`;

  // REDESIGN STEP 3 (Renato D3, "List sample 1"): on the unfiltered view
  // this is the "All books" grid under the shelves; a filtered view
  // shows the same grid under its result count only.
  return (
    <section id="all-books" className={isFiltered ? "mt-8" : "mt-14 scroll-mt-6"}>
      <div
        className={`flex flex-wrap items-baseline gap-3 border-b border-border pb-3 ${
          isFiltered ? "" : "justify-between"
        }`}
      >
        {!isFiltered && <h2 className={SECTION_HEADING}>All books</h2>}
        <p className="text-sm text-muted">{countLine}</p>
      </div>
      <ul className="mt-6 grid grid-cols-2 gap-x-5 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {books.map((book) => (
          <li key={book.id}>
            <BookCard
              book={book}
              coverUrl={coverUrlFor(supabase, book.cover_path)}
              authorName={resolvePublicAuthorName(book.profiles)}
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
        <h2 className={SECTION_HEADING}>Bundles</h2>
        <p className="mt-1 text-sm text-muted">Multiple books in one collection.</p>
      </div>
      <ul className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {bundles.map((bundle) => {
          const members = bundle.bundle_books ?? [];
          const covers = members
            .map((m) => m.books?.cover_path ?? null)
            .slice(0, BUNDLE_COVER_LIMIT);
          const authorName = resolvePublicAuthorName(bundle.profiles);
          const countLabel = `${members.length} ${members.length === 1 ? "book" : "books"}`;
          // Offsets are taken from the right so the front cover always
          // sits in the same place however many covers there are.
          const offsets = BUNDLE_COVER_OFFSETS.slice(BUNDLE_COVER_LIMIT - Math.max(covers.length, 1));

          return (
            <li key={bundle.id}>
              <Link
                href={`/bundles/${bundle.id}`}
                className="focus-ring group flex h-full items-center gap-4 rounded-[4px] border border-border bg-surface p-[18px] transition-colors hover:bg-surface-hover"
              >
                <div aria-hidden="true" className="relative h-[110px] w-24 shrink-0">
                  {(covers.length > 0 ? covers : [null]).map((url, i) => {
                    const src = coverUrlFor(supabase, url);
                    const position = `absolute h-24 w-16 rounded-[2px] ${offsets[i]} ${
                      i === Math.max(covers.length, 1) - 1 ? "shadow-[0_4px_10px_rgba(0,0,0,0.2)]" : ""
                    }`;
                    return src ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={i} src={src} alt="" className={`${position} object-cover`} />
                    ) : (
                      <div key={i} className={`${position} bg-border`} />
                    );
                  })}
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-serif text-lg leading-snug group-hover:underline">
                    {bundle.title}
                  </span>
                  <span className="text-[0.8125rem] text-muted">
                    {authorName ? `${countLabel} · ${authorName}` : countLabel}
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
        <h2 className="font-serif text-[1.625rem] font-normal">Are you an author?</h2>
        <p className="text-primary-foreground/80">
          Publish your book on Librum and earn royalties on every sale.
        </p>
      </div>
      <Link
        href={signedIn ? "/dashboard/books/new" : "/signup?role=author"}
        className="focus-ring inline-flex items-center justify-center rounded-[3px] bg-accent px-6 py-3.5 font-semibold text-accent-foreground transition-colors hover:bg-primary-foreground"
      >
        Start publishing
      </Link>
    </section>
  );
}
