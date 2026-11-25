import Link from "next/link";
import { AdultTag } from "@/components/adult-tag";
import { bundleIsAdult } from "@/lib/book-reader-details";
import { createClient } from "@/lib/supabase/server";
import { formatCatalogPriceLabel, resolveCatalogPriceState } from "@/lib/catalog-price";
import { parseBookstoreQuery, buildBookstoreHref, countCatalogueFacets, type FacetRow } from "@/lib/bookstore";
import { GENRES } from "@/lib/genres";
import { StoreBookCard } from "@/components/store-book-card";
import { EmptyState } from "@/components/ui/empty-state";
import { buttonClasses } from "@/components/ui/button";
import { resolveBookByline, resolveOriginalAuthor } from "@/lib/book-byline";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { getLibrumChoiceBook } from "@/lib/librum-choice";
import { resolveBookstoreFeature } from "@/lib/librum-choice-logic";
import {
  categoryButtons,
  NON_FICTION_GENRES,
  storeCardAction,
  summarizeRatings,
  type RatingSummary,
} from "@/lib/libraria-store";
import type { PublicBook, PublicBundle } from "@/lib/types";
import { authorPagePath, type PenNameRef } from "@/lib/pen-names";
import type { Metadata } from "next";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { DismissableDetails } from "@/components/dismissable-details";
import { DetailsCloseButton } from "@/components/details-close-button";
import { LISTED_BOOK_STATUSES } from "@/lib/preorder-reader";

export const metadata: Metadata = {
  title: "Libraria",
  description: "Zbuloni libra elektronikë të pavarur nga autorë që shkruajnë shqip në Librum.",
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see V3 §3.
export const dynamic = "force-dynamic";

// LR1 (Renato 11-25, hand sketch, pictures r4 and patch 1 pictures v2):
// Libraria is a shop front of shelves. Two views at one address:
//   - the shelves (no search, no category): the small feature strip
//     (until the banner, patch 3), "Më të rinjtë në Librum" with
//     category buttons and the "Më shumë kategori" box, "Libra
//     jo-artistikë", "Paketat" (lr1-10 a), and, for visitors only,
//     "Bota e leximit ju pret" (lr1-5 a, his text as written, lr1-11 b);
//   - the results (?q= and/or ?genre=): only the matching books, newest
//     first, with no filters and no sort (lr1-6 c, lr1-6b a).
// The sidebar filters, the price filter, the sort, the full list, the
// Klasikët shelf (lr1-7 a) and the "Jeni autor?" band are gone. Old
// links that carry ?sort=, ?minPrice= or ?maxPrice= still open, and
// those parts are ignored. The header is Libraria's own (layout.tsx).
// Buying stays on the book page except "Shto" (lr1-4 a), which adds a
// paid live book to the cart without leaving the page.

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
  }: {
    q?: string;
    genre?: string;
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
        // LR1 (lr1-6 a): no price filter any more.
        min_price_cents: null,
        max_price_cents: null,
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
      // newest-first order the no-search-term branch above uses.
      results = [...matchedBooks].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      );
    }
  }

  // LR1 (lr1-6 b a): results are newest first, with no sort menu.

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

function coverUrlFor(supabase: SupabaseClient, coverPath: string | null | undefined) {
  return coverPath
    ? supabase.storage.from("covers").getPublicUrl(coverPath).data.publicUrl
    : null;
}

// Books per shelf (5 across on a computer, as in the sketch).
const SHELF_SIZE = 5;

// The newest listed books, in any of `genres` when given -- the same
// listed-and-priced scoping as the results. Fail-soft: an error gives
// null, and the caller decides what that hides.
async function fetchShelf(
  supabase: SupabaseClient,
  genres?: readonly string[],
): Promise<BookWithAuthor[] | null> {
  let query = supabase
    .from("public_books")
    .select("*, pen:public_pen_names(id, name)")
    .in("status", LISTED_BOOK_STATUSES)
    .not("price_all", "is", null);
  if (genres) query = query.overlaps("categories", [...genres]);
  const { data, error } = await query
    .order("created_at", { ascending: false })
    .limit(SHELF_SIZE)
    .returns<BookWithAuthor[]>();
  if (error) {
    console.error("Libraria: failed to load a shelf:", error);
    return null;
  }
  return data ?? [];
}

// Which categories have a listed book (for the category buttons).
// Bounded like the old sidebar counts; a failed read gives no buttons.
const FACET_SCAN_LIMIT = 1000;

async function fetchGenresWithBooks(supabase: SupabaseClient): Promise<string[]> {
  const { data, error } = await supabase
    .from("public_books")
    .select("categories, pen:public_pen_names(id, name)")
    .in("status", LISTED_BOOK_STATUSES)
    .not("price_all", "is", null)
    .limit(FACET_SCAN_LIMIT)
    .returns<FacetRow[]>();
  if (error) {
    console.error("Libraria: failed to load the categories:", error);
    return [];
  }
  return countCatalogueFacets(data ?? []).genres.map((g) => g.genre);
}

// Approved reviews of the books on the page (public_reviews lists only
// approved ones and no reader). Fail-soft: no stars.
async function fetchRatings(supabase: SupabaseClient, bookIds: string[]): Promise<Map<string, RatingSummary>> {
  if (bookIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from("public_reviews")
    .select("book_id, rating")
    .in("book_id", bookIds)
    .returns<{ book_id: string; rating: number }[]>();
  if (error) {
    console.error("Libraria: failed to load the ratings:", error);
    return new Map();
  }
  return summarizeRatings(data ?? []);
}

// The signed-in reader's own cart rows (row rules return only theirs),
// so a book already in it reads "Në shportë". Gift rows don't count.
async function fetchCartBookIds(supabase: SupabaseClient, userId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("cart_items")
    .select("book_id")
    .eq("reader_id", userId)
    .is("gift_email", null)
    .returns<{ book_id: string }[]>();
  if (error) {
    console.error("Libraria: failed to load the cart:", error);
    return new Set();
  }
  return new Set((data ?? []).map((r) => r.book_id));
}

// lr1-12 a (audit N1): the books this reader already owns (through
// user_owns_book(), the same rule as the book page and the cart, so a
// refunded or lost-disputed purchase does not count) and their own books
// as an author. Their cards show "Shiko librin". One ownership call per
// purchase row, as on the Bibliotekë page.
async function fetchOwnedOrOwnBookIds(supabase: SupabaseClient, userId: string): Promise<Set<string>> {
  const [purchases, own] = await Promise.all([
    supabase.from("purchases").select("book_id").eq("reader_id", userId).returns<{ book_id: string }[]>(),
    supabase.from("books").select("id").eq("author_id", userId).returns<{ id: string }[]>(),
  ]);
  if (purchases.error) console.error("Libraria: failed to load the reader's purchases:", purchases.error);
  if (own.error) console.error("Libraria: failed to load the author's own books:", own.error);
  const ids = new Set((own.data ?? []).map((r) => r.id));
  const owned = await Promise.all(
    (purchases.data ?? []).map(
      async (r) => [r.book_id, !!(await supabase.rpc("user_owns_book", { target_book_id: r.book_id })).data] as const,
    ),
  );
  for (const [id, yes] of owned) if (yes) ids.add(id);
  return ids;
}

// A2 page heading: thin serif, as on the homepage (Renato D6).
const SECTION_HEADING = "font-serif text-[1.75rem] font-normal leading-tight text-primary sm:text-3xl";
const TEXT_LINK_CLASSES =
  "focus-ring rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2";

type CardContext = {
  supabase: SupabaseClient;
  ratings: Map<string, RatingSummary>;
  signedIn: boolean;
  cartBookIds: Set<string>;
  ownedOrOwnBookIds: Set<string>;
};

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
  // Only the words and the category count now (lr1-6 c).
  const { q, genre } = parseBookstoreQuery(rawQuery);
  const words = q?.trim() || undefined;
  const isResults = Boolean(words || genre);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [cartBookIds, ownedOrOwnBookIds] = user
    ? await Promise.all([fetchCartBookIds(supabase, user.id), fetchOwnedOrOwnBookIds(supabase, user.id)])
    : [new Set<string>(), new Set<string>()];

  if (isResults) {
    const { books, error, totalMatched } = await fetchSearchResults(supabase, { q: words, genre });
    const ratings = await fetchRatings(supabase, books.map((b) => b.id));
    const ctx: CardContext = { supabase, ratings, signedIn: !!user, cartBookIds, ownedOrOwnBookIds };
    return (
      <main className="flex-1 bg-surface">
        <div className="page-container pt-5 pb-10 sm:pt-6 md:pb-12">
          <ResultsView words={words} genre={genre} books={books} error={error} totalMatched={totalMatched} ctx={ctx} />
        </div>
      </main>
    );
  }

  const [newest, nonFiction, bundles, librumChoice, genresWithBooks] = await Promise.all([
    fetchShelf(supabase),
    fetchShelf(supabase, NON_FICTION_GENRES),
    fetchPublishedBundles(supabase),
    getLibrumChoiceBook(),
    fetchGenresWithBooks(supabase),
  ]);
  const shown = [...(newest ?? []), ...(nonFiction ?? [])];
  const ratings = await fetchRatings(supabase, [...new Set(shown.map((b) => b.id))]);
  const ctx: CardContext = { supabase, ratings, signedIn: !!user, cartBookIds, ownedOrOwnBookIds };

  // Decision 1: the feature strip stays on top until the banner (patch
  // 3): the priced pick as "Librum's choice", else the newest book.
  const featured = newest && newest.length > 0 ? resolveBookstoreFeature<BookWithAuthor>(librumChoice, newest[0]) : null;

  return (
    <main className="flex-1 bg-surface">
      <div className="page-container pt-5 pb-10 sm:pt-6 md:pb-12">
        <h1 className="sr-only">Libraria</h1>
        {featured && (
          <FeaturedStrip
            book={featured.book}
            label={featured.label}
            coverUrl={coverUrlFor(supabase, featured.book.cover_path)}
          />
        )}

        {newest === null ? (
          <EmptyState
            className="mt-10"
            title="Libraria nuk u hap dot tani."
            description="Ju lutemi provoni përsëri pas pak."
          />
        ) : newest.length === 0 ? (
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
        ) : (
          <Shelf title="Më të rinjtë në Librum" books={newest} ctx={ctx} first={!featured}>
            <CategoryButtons genres={categoryButtons(genresWithBooks)} />
          </Shelf>
        )}

        {nonFiction && nonFiction.length > 0 && <Shelf title="Libra jo-artistikë" books={nonFiction} ctx={ctx} />}

        {bundles.length > 0 && <BundlesSection bundles={bundles} supabase={supabase} />}

        {!user && <ReadingInvite />}
      </div>
    </main>
  );
}

// A shelf: a serif title, anything given (the category buttons), then
// one row of cards -- 5 across from lg, a row that scrolls sideways on
// phones. No "›" link (decision 4: there is no full list).
function Shelf({
  title,
  books,
  ctx,
  first = false,
  children,
}: {
  title: string;
  books: BookWithAuthor[];
  ctx: CardContext;
  first?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section className={`${first ? "mt-4" : "mt-10 sm:mt-12"} border-b border-border pb-9`}>
      <h2 className={SECTION_HEADING}>{title}</h2>
      {children}
      <ul className="relative -mx-4 mt-5 flex gap-4 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-3 sm:gap-6 sm:overflow-visible sm:px-0 sm:pb-0 md:grid-cols-4 lg:grid-cols-5">
        {books.map((book) => (
          <li key={book.id} className="w-[42%] shrink-0 sm:w-auto">
            <Card book={book} ctx={ctx} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Card({ book, ctx }: { book: BookWithAuthor; ctx: CardContext }) {
  return (
    <StoreBookCard
      book={book}
      coverUrl={coverUrlFor(ctx.supabase, book.cover_path)}
      authorName={resolveBookByline(book)}
      rating={ctx.ratings.get(book.id) ?? null}
      action={storeCardAction(book, ctx.signedIn, ctx.cartBookIds.has(book.id), ctx.ownedOrOwnBookIds.has(book.id))}
    />
  );
}

// The buttons under "Më të rinjtë": "Të gjitha kategoritë" (this view,
// so it is the selected one), up to four categories (decision 2), then
// "Më shumë kategori", a box with every category as plain text (Renato
// 18:25Z). A tap on a category opens its results. The box closes on
// its ✕, a tap outside, Escape or a tap on a category. On phones the
// buttons stay one row that scrolls sideways and the box opens over
// the page.
const PILL =
  "focus-ring inline-flex min-h-11 items-center rounded-full border border-[#c9bfa9] bg-[#fffdf8] px-4 text-[0.9375rem] whitespace-nowrap text-foreground transition-colors hover:bg-surface-hover";

function CategoryButtons({ genres }: { genres: string[] }) {
  return (
    <div className="-mx-4 mt-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 sm:relative sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
      <Link href="/librari" aria-current="page" className={`${PILL} border-primary! bg-primary! text-primary-foreground!`}>
        Të gjitha kategoritë
      </Link>
      {genres.map((g) => (
        <Link key={g} href={buildBookstoreHref({}, { genre: g })} className={PILL}>
          {g}
        </Link>
      ))}
      <DismissableDetails className="group" closeOnLinkClick>
        <summary
          className={`${PILL} cursor-pointer list-none gap-1.5 border-primary! font-semibold text-primary! [&::-webkit-details-marker]:hidden`}
        >
          Më shumë kategori
          <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none">
            <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </summary>
        <div
          role="group"
          aria-label="Të gjitha kategoritë"
          className="fixed inset-x-4 top-28 z-40 max-h-[75vh] overflow-y-auto rounded-[10px] border border-[#d9cdb0] bg-[#fffdf8] p-5 shadow-[0_18px_40px_rgba(0,0,0,0.18)] sm:absolute sm:inset-x-auto sm:top-[calc(100%+0.5rem)] sm:right-0 sm:w-[36rem] sm:max-h-none sm:p-6"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="font-serif text-lg text-foreground">Të gjitha kategoritë</p>
            <DetailsCloseButton label="Mbyll kategoritë" />
          </div>
          <ul className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
            {GENRES.map((g) => (
              <li key={g}>
                <Link
                  href={buildBookstoreHref({}, { genre: g })}
                  className="focus-ring flex min-h-11 items-center rounded-sm px-1 text-[0.9375rem] text-foreground underline decoration-transparent underline-offset-2 hover:decoration-current"
                >
                  {g}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </DismissableDetails>
    </div>
  );
}

// The results view: the category (or the words) as the title, the
// count, one chip per part that removes it, then the matching books.
function ResultsView({
  words,
  genre,
  books,
  error,
  totalMatched,
  ctx,
}: {
  words: string | undefined;
  genre: string | undefined;
  books: BookWithAuthor[];
  error: boolean;
  totalMatched: number;
  ctx: CardContext;
}) {
  const title = genre ?? `“${words}”`;
  const chips: { label: string; href: string }[] = [];
  if (genre) chips.push({ label: genre, href: buildBookstoreHref({}, { q: words }) });
  if (words) chips.push({ label: `“${words}”`, href: buildBookstoreHref({}, { genre }) });

  return (
    <>
      <div className="flex items-end justify-between gap-6 border-b border-border pb-4">
        <h1 className="min-w-0 font-serif text-[2.25rem] leading-tight font-normal break-words text-primary sm:text-[2.75rem]">
          {title}
        </h1>
        {!error && (
          <p className="shrink-0 text-base whitespace-nowrap text-muted" aria-live="polite">
            {countLineFor(totalMatched)}
          </p>
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {chips.map((c) => (
          <Link
            key={c.label}
            href={c.href}
            aria-label={`Hiq ${c.label}`}
            className="focus-ring group -my-1 inline-flex min-h-11 max-w-full min-w-0 items-center rounded-full"
          >
            <span className="inline-flex min-h-9 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-primary/10 px-3 text-sm font-semibold text-primary group-hover:bg-primary/15">
              <span className="min-w-0 truncate">{c.label}</span>
              <svg aria-hidden="true" viewBox="0 0 12 12" className="size-3 shrink-0">
                <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" />
              </svg>
            </span>
          </Link>
        ))}
      </div>

      {error ? (
        <EmptyState
          className="mt-10"
          title="Libraria nuk u hap dot tani."
          description="Ju lutemi provoni përsëri pas pak."
        />
      ) : books.length === 0 ? (
        <EmptyState
          className="mt-10"
          title="Asnjë libër nuk përputhet me kërkimin tuaj."
          description="Provoni një fjalë tjetër ose një kategori tjetër."
          action={
            <Link href="/librari" className={buttonClasses("outline", "sm")}>
              Kthehu te Libraria
            </Link>
          }
        />
      ) : (
        <ul className="mt-6 grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 sm:gap-x-6 md:grid-cols-4 lg:grid-cols-5">
          {books.map((book) => (
            <li key={book.id}>
              <Card book={book} ctx={ctx} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// The results' count: every match when it fits, else the visible cap.
function countLineFor(totalMatched: number): string {
  return totalMatched <= SEARCH_RESULT_LIMIT
    ? `${totalMatched} ${totalMatched === 1 ? "libër" : "libra"}`
    : `Po shfaqen ${SEARCH_RESULT_LIMIT} librat e parë`;
}

// lr1-5 a / lr1-11 b: the closing box, for visitors only (decision 7),
// with Renato's text exactly as he wrote it.
function ReadingInvite() {
  return (
    <section className="mx-auto mt-14 flex max-w-[40rem] flex-col items-center gap-3 text-center">
      <svg aria-hidden="true" viewBox="0 0 24 24" className="size-10 text-[#806510]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V17h5v-1.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" />
      </svg>
      <h2 className="font-serif text-[1.75rem] font-normal text-foreground sm:text-[2rem]">Bota e leximit ju pret</h2>
      <p className="text-foreground/80">
        Krijoni një llogari falas në Librum dhe regjistrohuni për të marrë emailet tona. Mësoni më shumë për librat e
        rinj, ofertat dhe merrni sugjerime leximi nga ekipi ynë.
      </p>
      <Link
        href="/signup"
        className="focus-ring mt-2 inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-6 font-semibold text-accent-foreground transition-colors hover:bg-primary-foreground"
      >
        Krijo llogari
      </Link>
    </section>
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

