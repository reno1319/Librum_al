import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { GENRES } from "@/lib/genres";
import { formatPrice } from "@/lib/pricing";
import {
  parseBookstoreQuery,
  buildBookstoreHref,
  toggleGenreHref,
  BOOKSTORE_SORT_OPTIONS,
  type BookstoreQuery,
} from "@/lib/bookstore";
import { BookCard } from "@/components/book-card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import type { Book, Bundle, Profile } from "@/lib/types";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Bookstore",
  description: "Discover independent ebooks published by Albanian-language authors on Librum.",
};

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

type BookWithAuthor = Book & { profiles: Pick<Profile, "display_name"> | null };
type BundleWithAuthor = Pick<Bundle, "id" | "title" | "price_cents"> & {
  profiles: Pick<Profile, "display_name"> | null;
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
    minPriceCents,
    maxPriceCents,
  }: {
    q?: string;
    genre?: string;
    sort?: string;
    minPriceCents?: number;
    maxPriceCents?: number;
  },
): Promise<{ books: BookWithAuthor[]; error: boolean; totalMatched: number }> {
  const baseQuery = () => {
    let query = supabase
      .from("books")
      .select("*, profiles(display_name)")
      .eq("status", "published");
    if (genre) query = query.eq("genre", genre);
    if (minPriceCents != null) query = query.gte("price_cents", minPriceCents);
    if (maxPriceCents != null) query = query.lte("price_cents", maxPriceCents);
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
    const { data: matches, error: searchError } = await supabase.rpc(
      "search_books",
      {
        search_term: term,
        genre_filter: genre ?? null,
        min_price_cents: minPriceCents ?? null,
        max_price_cents: maxPriceCents ?? null,
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
          .select("*, profiles(display_name)")
          .eq("status", "published")
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

  if (sort === "price_asc") {
    results = [...results].sort((a, b) => a.price_cents - b.price_cents);
  } else if (sort === "price_desc") {
    results = [...results].sort((a, b) => b.price_cents - a.price_cents);
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
async function fetchPublishedBundles(
  supabase: SupabaseClient,
): Promise<BundleWithAuthor[]> {
  const { data, error } = await supabase
    .from("bundles")
    .select("id, title, price_cents, profiles(display_name)")
    .eq("status", "published")
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
  const rawQuery = await searchParams;
  const supabase = await createClient();
  const { q, genre, sort, minPriceCents, maxPriceCents, isFiltered } =
    parseBookstoreQuery(rawQuery);

  // Bundles are a secondary discovery feature, not part of the book
  // search result set -- showing unrelated bundles below filtered book
  // results would weaken the reader's search/filter mental model, so
  // the section (and the query behind it) is skipped entirely once any
  // search/genre/sort/price filter is active. See BundlesSection's own
  // render site below for where this is enforced a second time,
  // defensively, rather than relying solely on the empty array here.
  const [{ books, error, totalMatched }, bundles] = await Promise.all([
    fetchSearchResults(supabase, { q, genre, sort, minPriceCents, maxPriceCents }),
    isFiltered ? Promise.resolve([]) : fetchPublishedBundles(supabase),
  ]);

  return (
    <main className="flex-1 bg-background">
      <div className="mx-auto w-full max-w-wide px-4 py-10 sm:px-6 md:py-14">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">
            Librum Bookstore
          </p>
          <h1 className="mt-2 font-serif text-3xl font-bold sm:text-4xl">
            Discover independent books.
          </h1>
          <p className="mt-2 text-muted">
            Books published directly by Albanian-language authors.
          </p>
        </div>

        <BookstoreToolbar query={rawQuery} isFiltered={isFiltered} />

        <BookGrid
          supabase={supabase}
          books={books}
          error={error}
          totalMatched={totalMatched}
          isFiltered={isFiltered}
        />

        {!isFiltered && bundles.length > 0 && <BundlesSection bundles={bundles} />}
      </div>
    </main>
  );
}

function BookstoreToolbar({
  query,
  isFiltered,
}: {
  query: BookstoreQuery;
  isFiltered: boolean;
}) {
  const { q, genre, sort, minPrice, maxPrice } = query;

  return (
    <div className="mt-8">
      <form
        action="/bookstore"
        method="get"
        className="flex flex-col gap-3 sm:flex-row sm:items-center"
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
          className="focus-ring flex-1 rounded-md border border-border bg-surface px-3 py-1.5 text-sm"
        />

        <label htmlFor="bookstore-sort" className="sr-only">
          Sort by
        </label>
        <select
          id="bookstore-sort"
          name="sort"
          defaultValue={sort ?? ""}
          className="focus-ring rounded-md border border-border bg-surface px-3 py-1.5 text-sm text-muted sm:w-48"
        >
          {BOOKSTORE_SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>

        {/* A plain GET form only sends its own named fields -- these
            preserve the current genre/price selections so submitting a
            new search term (or changing sort) doesn't silently discard
            them. */}
        {genre && <input type="hidden" name="genre" value={genre} />}
        {minPrice && <input type="hidden" name="minPrice" value={minPrice} />}
        {maxPrice && <input type="hidden" name="maxPrice" value={maxPrice} />}

        <button type="submit" className={buttonClasses("primary", "sm")}>
          Search
        </button>
      </form>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-1 flex-nowrap gap-1.5 overflow-x-auto pb-1 sm:flex-wrap sm:overflow-visible">
          <GenreChip
            label="All genres"
            href={buildBookstoreHref(query, { genre: undefined })}
            active={!genre}
            subdued
          />
          {GENRES.map((g) => (
            <GenreChip key={g} label={g} href={toggleGenreHref(query, g)} active={genre === g} />
          ))}
        </div>

        <details className="rounded-md border border-border bg-surface text-sm">
          <summary className="focus-ring cursor-pointer select-none rounded-md px-3 py-1.5">
            Price range
          </summary>
          <form
            action="/bookstore"
            method="get"
            className="flex flex-wrap items-end gap-3 border-t border-border p-3"
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
                placeholder="$0"
                min="0"
                step="0.01"
                className="focus-ring w-20 rounded-md border border-border bg-surface px-2 py-1 text-sm"
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
                step="0.01"
                className="focus-ring w-20 rounded-md border border-border bg-surface px-2 py-1 text-sm"
              />
            </div>
            <button type="submit" className={buttonClasses("outline", "sm")}>
              Apply
            </button>
          </form>
        </details>

        {isFiltered && (
          <Link
            href="/bookstore"
            className="focus-ring rounded-sm text-sm font-medium text-primary hover:underline"
          >
            Clear filters
          </Link>
        )}
      </div>
    </div>
  );
}

function GenreChip({
  label,
  href,
  active,
  subdued = false,
}: {
  label: string;
  href: string;
  active: boolean;
  // The default "All genres" chip stays neutral even when it's the
  // effectively-active state (no genre selected) -- a strongly-filled
  // violet badge on the default option would read as "a genre is
  // selected" when none is. Only a real genre selection gets the
  // clearly-violet active treatment below.
  subdued?: boolean;
}) {
  const activeClasses = subdued
    ? "border-border bg-surface font-medium text-foreground"
    : "border-primary bg-primary/10 font-medium text-primary";

  return (
    <Link
      href={href}
      aria-current={active ? "true" : undefined}
      className={`focus-ring shrink-0 rounded-full border px-2.5 py-1 text-sm transition-colors ${
        active ? activeClasses : "border-border/60 text-foreground/80 hover:bg-surface-hover"
      }`}
    >
      {label}
    </Link>
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
          <Link
            href="/"
            className="focus-ring rounded-sm text-sm font-medium text-primary hover:underline"
          >
            Back to Home
          </Link>
        }
      />
    );
  }

  return (
    <div className="mt-8">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">
        {totalMatched <= SEARCH_RESULT_LIMIT
          ? `${totalMatched} ${totalMatched === 1 ? "book" : "books"}`
          : `Showing the first ${SEARCH_RESULT_LIMIT} books`}
      </p>
      <ul className="mt-4 grid grid-cols-2 gap-x-6 gap-y-10 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {books.map((book) => {
          const coverUrl = book.cover_path
            ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data
                .publicUrl
            : null;

          return (
            <li key={book.id}>
              <BookCard
                book={book}
                coverUrl={coverUrl}
                authorName={book.profiles?.display_name}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function BundlesSection({ bundles }: { bundles: BundleWithAuthor[] }) {
  return (
    <section className="mt-14 border-t border-border pt-10">
      <h2 className="font-serif text-xl font-bold">Bundles</h2>
      <p className="mt-1 text-sm text-muted">Multiple books in one collection.</p>
      <ul className="mt-5 flex flex-col gap-2.5">
        {bundles.map((bundle) => (
          <li key={bundle.id}>
            <Link
              href={`/bundles/${bundle.id}`}
              className="focus-ring flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-5 py-4 text-sm transition-colors hover:bg-surface-hover"
            >
              <span className="font-serif text-base font-semibold">{bundle.title}</span>
              {bundle.profiles?.display_name && (
                <span className="text-xs text-muted">by {bundle.profiles.display_name}</span>
              )}
              <span className="ml-auto font-semibold text-primary">
                {formatPrice(bundle.price_cents)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
