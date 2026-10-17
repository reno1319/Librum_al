import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buyBook,
  getFreeBook,
  submitReview,
  addToWishlist,
  removeFromWishlist,
} from "./actions";
import { followAuthor, unfollowAuthor } from "../../authors/[id]/actions";
import { buildBookstoreHref } from "@/lib/bookstore";
import { StarRating } from "@/components/star-rating";
import { BookShelf } from "@/components/book-shelf";
import { BookSampleReader } from "@/components/book-sample-reader";
import { CONTRIBUTOR_ROLE_VERB } from "@/lib/contributor-roles";
import { getLanguageLabel } from "@/lib/languages";
import { formatDateOnly, formatTimestampAsDate } from "@/lib/book-detail-dates";
import { formatTransactionAmount, provenanceFromStoredCurrency } from "@/lib/transaction-money";
import { formatCatalogPriceLabel } from "@/lib/catalog-price";
import { resolveActiveCheckoutProvider } from "@/lib/checkout-regime";
import { canStartPaidCheckout } from "@/lib/paid-readiness";
import {
  resolveBookPurchaseState,
  resolveShowSample,
  resolveCheckoutSecurityNote,
  type BookPurchaseState,
} from "@/lib/book-purchase";
import { orderSeriesBooks, resolveSeriesNeighbors } from "@/lib/series-order";
import { resolvePublicAuthorName } from "@/lib/author-name";
import { buttonClasses } from "@/components/ui/button";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import type { Book, Profile, Review, Series, Contributor } from "@/lib/types";
import { CoverPlaceholder } from "@/components/cover-placeholder";

// LIBRUM 2.0 UI-5: this page is the reader DECISION + PURCHASE surface
// -- Bookstore (UI-4) owns discovery/browsing, this page owns "should I
// buy this book." Every server action bound into a form here is
// unchanged since UI-5 -- see actions.ts/checkout-logic.ts, neither of
// which any pass touching this file has ever modified.
//
// LIBRUM 2.0 PERF-1: query CONCURRENCY was revisited in this pass (see
// getBookForDetail's own comment, and the two Promise.all groupings
// below) -- purely a scheduling change. No query's actual filter
// conditions, no visibility rule, and no business/purchase logic
// changed; every query still runs, still returns the same rows it
// always did, just not all of them one-at-a-time anymore.

// The book's own author/profile join needs `bio` (for the "About the
// Author" section) and, since PRODUCT-1, `avatar_path` (for that same
// section's avatar thumbnail) on top of the `display_name`/
// `public_author_name` pair every other book-with-author query on this
// page already selects -- kept as its own type, distinct from
// BookWithAuthor below, so the shelf queries (which only ever need the
// name pair) aren't forced to also carry fields they never fetch.
// Extending this one existing joined select (rather than adding a
// second, sequential profile query) is exactly what PERF-1's own
// concurrency work calls for reusing.
//
// LIBRUM 2.0 AUTHOR-1B: every render site below resolves author
// attribution through resolvePublicAuthorName(), never a raw
// display_name read, so a pseudonymous author's private account name
// never leaks here.
//
// LIBRUM 2.0 AUTHOR-1C: all four profiles joins on this page (this one,
// the reviews join, and the moreByAuthor/youMightLike joins further
// below) now read the safe public_author_profiles VIEW (migration 045),
// aliased back to `profiles` in every select string so property access
// (`book.profiles`, `review.profiles`) needs no further changes. That
// view physically has no display_name column, so every one of these
// types drops "display_name" from its Pick<Profile, ...>. This
// includes ReviewWithReader, previously left deliberately untouched by
// AUTHOR-1B (a reviewer's own account identity was treated as a
// separate concept from author attribution) -- AUTHOR-1C's database-level
// fix necessarily changes that: display_name is now a private column no
// ordinary reader/anon query can read for ANYONE else's row, author or
// reviewer alike, so this join can no longer request it at all without
// breaking the whole page with a hard permission error. See the reviews
// render site further below for the resulting fallback behavior.
type BookWithAuthorBio = Book & {
  profiles: Pick<Profile, "public_author_name" | "bio" | "avatar_path"> | null;
};
type BookWithAuthor = Book & {
  profiles: Pick<Profile, "public_author_name"> | null;
};
// LIBRUM 2.0 PRODUCT-3: `created_at` added to what this already-existing
// query selects (no new query, no new PERF-1 batch member) so
// orderSeriesBooks() -- shared with the public Series page -- has the
// same deterministic tie-break data here that it has there. The `.order()`
// call below stays as a DB-level head start; orderSeriesBooks() is the
// actual authoritative order both surfaces agree on.
type SeriesEntry = Pick<Book, "id" | "title" | "series_position" | "created_at">;
type ReviewWithReader = Review & {
  profiles: Pick<Profile, "public_author_name"> | null;
};

// ALL-CUTOVER APP-A: reads the maintenance env var on every request, so
// this route must never be statically cached -- see V3 §3.
export const dynamic = "force-dynamic";

const METADATA_DESCRIPTION_MAX = 160;

function truncateForMetadata(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

// LIBRUM 2.0 PERF-1: generateMetadata() and the page component below are
// separate invocations Next.js calls for the same request -- neither
// automatically sees the other's already-fetched data. Before this pass
// each ran its own independent `books` fetch (metadata's narrower,
// title/description/status/cover_path only; the page's wider `*,
// profiles(display_name,bio)`), meaning every single Book Detail view
// paid for the book row twice. `cache()` (React's own per-request
// memoization, NOT a persistent/cross-request cache -- it's cleared once
// this request finishes) makes both callers share the one, wider fetch:
// whichever runs first (generateMetadata, per Next's own render order)
// populates it, the page component's own call just reuses the resolved
// value. Each caller still applies its OWN visibility rule against the
// shared row -- metadata's own "published only" gate and the page's own
// "author OR owner OR published" gate are both untouched below, so this
// changes nothing about what either caller does with the data, only how
// many times the row is fetched. No user-specific data (ownership,
// wishlist, auth) is ever part of this cached call -- those stay
// separate, uncached, per-request queries exactly as before.
const getBookForDetail = cache(async (id: string) => {
  const supabase = await createClient();
  const { data: book } = await supabase
    .from("books")
    .select("*, profiles:public_author_profiles(public_author_name, bio, avatar_path)")
    .eq("id", id)
    .single<BookWithAuthorBio>();
  return book;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  // ALL-CUTOVER APP-A: no book-specific metadata (and no Supabase call
  // via getBookForDetail) while maintenance is active -- the same {}
  // fallback this function already uses for a draft/unpublished/
  // nonexistent book, letting the root layout's generic metadata apply.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return {};
  }

  const { id } = await params;
  const book = await getBookForDetail(id);

  // Draft/unpublished/nonexistent books never get book-specific public
  // metadata. An author can still view their own draft's page body, but
  // metadata lives in <head> and can be read by crawlers/link-preview
  // bots regardless of who's logged in -- it must never present a
  // private draft's title/description/cover as public marketing copy.
  // Falling back to {} lets the root layout's generic site metadata
  // apply instead.
  if (!book || book.status !== "published") {
    return {};
  }

  // LIBRUM 2.0 SEO-1: `title` is the bare book title, deliberately NOT
  // suffixed here -- the root layout's "%s | Librum" title template
  // appends that automatically, so a manual suffix here would render as
  // "<title> | Librum | Librum". Open Graph's own title is a separate
  // field the template never touches, so it keeps its existing
  // "<title> — Librum" form unchanged (no Open Graph format change).
  const title = book.title;
  const ogTitle = `${book.title} — Librum`;
  const description = book.description
    ? truncateForMetadata(book.description, METADATA_DESCRIPTION_MAX)
    : undefined;
  // Local URL construction only -- getPublicUrl() makes no network call,
  // so creating a client here purely for this doesn't reintroduce a
  // second `books` fetch.
  const supabase = await createClient();
  const coverUrl = book.cover_path
    ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
    : null;

  return {
    title,
    description,
    openGraph: {
      title: ogTitle,
      description,
      type: "book",
      ...(coverUrl ? { images: [{ url: coverUrl }] } : {}),
    },
    twitter: {
      card: "summary_large_image",
    },
  };
}

// STALE-CHECKOUT-1: the only shape a checkout_conflict query parameter
// is ever allowed to have. It selects a row; it never carries data.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The frozen quote as get_book_checkout_quote returns it. price and
// currency come from the database row, never from the URL.
type HeldQuote = {
  intent_id: string;
  price_cents_at_checkout: number;
  currency: string;
  discount_code_id: string | null;
  expires_at: string;
  provider_window_ends_at: string | null;
  quote_state: string;
};

export default async function BookDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    purchase?: string;
    free?: string;
    review?: string;
    report?: string;
    error?: string;
    // STALE-CHECKOUT-1: an INTENT ID, never an amount. The frozen
    // economics shown to the reader are read back from the database
    // under that id; nothing about the money this page displays or that
    // a resume submits can be steered from the query string.
    checkout_conflict?: string;
    checkout_expired?: string;
    // QA-FIX-2: set by POK's failRedirectUrl (src/lib/pok-checkout.ts)
    // when the reader cancels or the payment fails on POK's page.
    canceled?: string;
  }>;
}) {
  // ALL-CUTOVER APP-A: schema-sensitive public book detail page (V3 §3)
  // -- checked as the first statement, before any Supabase call.
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { id } = await params;
  const {
    purchase,
    free: freeStatus,
    review: reviewStatus,
    report: reportStatus,
    error,
    checkout_conflict: checkoutConflict,
    checkout_expired: checkoutExpired,
    canceled,
  } = await searchParams;

  const supabase = await createClient();

  // LIBRUM 2.0 PERF-1: getUser() and the book fetch are INDEPENDENT of
  // each other in this codebase -- the book select below doesn't filter
  // on `user` at all (RLS enforces visibility server-side from the
  // request's own cookies, already attached to `supabase` regardless of
  // whether getUser() has resolved yet), and getUser() doesn't need
  // anything from `book`. Previously sequential; now dispatched together.
  // `getBookForDetail` is the same React.cache()-memoized fetch
  // generateMetadata() already ran for this request -- see its own
  // comment above for why sharing it is safe here.
  const [
    {
      data: { user },
    },
    book,
  ] = await Promise.all([supabase.auth.getUser(), getBookForDetail(id)]);

  if (!book) {
    notFound();
  }

  const isAuthor = user?.id === book.author_id;

  // LAUNCH-1 P1-7A: routed through user_owns_book() (also excludes a
  // purchase whose payment intent has a dispute at status 'lost', see
  // migration 035) rather than a raw purchases select -- public.
  // payment_disputes is fully closed to this request-scoped client, and
  // this SECURITY DEFINER RPC already encapsulates the complete,
  // correct ownership predicate (the same one the download route and
  // submitReview now also use). This is a display/UX check, not a
  // security boundary -- the download route independently re-verifies.
  //
  // LIBRUM 2.0 PERF-1: kept sequential and ahead of the visibility gate,
  // unchanged -- `wishlisted` is only meaningful (and only queried) once
  // `owned` is known (DEPENDENT), and the gate right below needs `owned`
  // itself. Neither depends on any of the presentation data fetched
  // further down, so this short chain doesn't block the parallel batch
  // from starting as soon as it's done.
  let owned = false;
  let wishlisted = false;
  if (user) {
    const { data: ownsBook } = await supabase.rpc("user_owns_book", {
      target_book_id: id,
    });
    owned = !!ownsBook;

    if (!owned) {
      const { data: wishlistRow } = await supabase
        .from("wishlist_items")
        .select("id")
        .eq("book_id", id)
        .eq("reader_id", user.id)
        .maybeSingle();
      wishlisted = !!wishlistRow;
    }
  }

  // Belt-and-suspenders on top of RLS: even though RLS should already
  // make an unrelated user's fetch above return no row, this explicit
  // check is what actually decides visibility from the application's
  // point of view, and keeps this page's behavior legible without
  // having to reason about the RLS policy to know what it does.
  if (book.status !== "published" && !isAuthor && !owned) {
    notFound();
  }

  const coverUrl = book.cover_path
    ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
    : null;

  // LIBRUM 2.0 PERF-1: everything below is INDEPENDENT -- each query
  // depends only on fields already known from `book` itself (id,
  // author_id, genre, series_id, status), never on `owned`/`wishlisted`
  // or on each other's results. Previously six-plus sequential round
  // trips (reviews, contributors, series row, series entries, more-by-
  // author, you-might-like, plus a synchronously-awaited book_views
  // insert in between); now one batch bounded by the slowest single
  // query. Series entries only need `book.series_id` -- confirmed by
  // reading its own query below, which never references the series
  // row's own fetched data -- so it runs alongside the series row
  // fetch, not after it. `book_views`' insert result is never read, so
  // it joins the batch too instead of blocking ahead of it.
  // Conditional members use `Promise.resolve({ data: null })` (a
  // resolved value, not a query) to keep positions/shapes uniform --
  // never a real query run just to fill a slot.
  const [
    { data: reviews },
    { data: contributors },
    { data: seriesRow },
    { data: seriesEntriesData },
    { data: moreByAuthor },
    { data: youMightLikeData },
    { data: followRow },
  ] = await Promise.all([
    supabase
      .from("reviews")
      .select("*, profiles:public_author_profiles(public_author_name)")
      .eq("book_id", id)
      .order("created_at", { ascending: false })
      .returns<ReviewWithReader[]>(),
    supabase
      .from("book_contributors")
      .select("*")
      .eq("book_id", id)
      .order("created_at")
      .returns<Contributor[]>(),
    book.series_id
      ? supabase.from("series").select("*").eq("id", book.series_id).maybeSingle<Series>()
      : Promise.resolve({ data: null }),
    // ALL-WIRING-2: all three of these lists are navigation/discovery --
    // "the rest of this series", "more by this author", "you might
    // like" -- so each excludes a book with no authored ALL price. Such
    // a row is not ALL-ready: it is neither free nor purchasable, so
    // offering it as a next thing to read would be an invitation the
    // storefront cannot honour. Its own detail page stays reachable.
    book.series_id
      ? supabase
          .from("books")
          .select("id, title, series_position, created_at")
          .eq("series_id", book.series_id)
          .eq("status", "published")
          .not("price_all", "is", null)
          .order("series_position", { ascending: true, nullsFirst: false })
          .returns<SeriesEntry[]>()
      : Promise.resolve({ data: null }),
    supabase
      .from("books")
      .select("*, profiles:public_author_profiles(public_author_name)")
      .eq("status", "published")
      .not("price_all", "is", null)
      .eq("author_id", book.author_id)
      .neq("id", id)
      .order("created_at", { ascending: false })
      .limit(8)
      .returns<BookWithAuthor[]>(),
    book.genre
      ? supabase
          .from("books")
          .select("*, profiles:public_author_profiles(public_author_name)")
          .eq("status", "published")
          .not("price_all", "is", null)
          .eq("genre", book.genre)
          .neq("id", id)
          .neq("author_id", book.author_id)
          .order("created_at", { ascending: false })
          .limit(8)
          .returns<BookWithAuthor[]>()
      : Promise.resolve({ data: null }),
    // REDESIGN STEP 3 (B5): whether this reader already follows the
    // author, for the Follow button in About the Author -- the same
    // query the author's own page runs. Never asked for the author
    // themself or for a visitor who is not signed in.
    user && !isAuthor
      ? supabase
          .from("author_follows")
          .select("id")
          .eq("follower_id", user.id)
          .eq("author_id", book.author_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // A basic view count, not deduplicated unique visitors — a reload
    // or a repeat visit counts again. Only published books, and never
    // the author's own visits (so previewing/editing doesn't inflate
    // it). Admin client because this is a system-recorded event, not
    // something tied to the viewer's own RLS-governed rows. Its result
    // is never read -- it rides along in this batch purely so its
    // latency doesn't sit ahead of the rest.
    book.status === "published" && !isAuthor
      ? createAdminClient().from("book_views").insert({ book_id: id })
      : Promise.resolve(null),
  ]);

  const allReviews = reviews ?? [];
  const reviewCount = allReviews.length;
  const averageRating =
    reviewCount > 0
      ? allReviews.reduce((sum, r) => sum + r.rating, 0) / reviewCount
      : 0;
  const myReview = user
    ? (allReviews.find((r) => r.reader_id === user.id) ?? null)
    : null;

  const seriesInfo: Series | null = seriesRow ?? null;
  // LIBRUM 2.0 PRODUCT-3: orderSeriesBooks() is the same canonical
  // ordering the public Series page uses -- see src/lib/series-order.ts.
  // No extra query: this re-sorts the exact PERF-1 Group B rows already
  // fetched above, it doesn't fetch anything new.
  const seriesEntries: SeriesEntry[] = orderSeriesBooks(seriesEntriesData ?? []);
  // Absent from `seriesEntries` (e.g. the author previewing their own
  // still-unpublished book, which the published-only query above never
  // returns) resolves to no neighbors on either side, not a guess.
  const { previous: previousInSeries, next: nextInSeries } = seriesInfo
    ? resolveSeriesNeighbors(seriesEntries, book.id)
    : { previous: null, next: null };
  const youMightLike: BookWithAuthor[] = youMightLikeData ?? [];
  const isFollowingAuthor = !!followRow;

  // PAID-CHECKOUT-SURFACE-1: read once, from the one server-only
  // interpretation of PAID_CHECKOUT_MODE buyBook itself uses. Nothing
  // about it reaches the browser except which controls are rendered.
  const paidCheckoutAvailable = canStartPaidCheckout();
  const purchaseState = resolveBookPurchaseState({
    user: user ? { id: user.id } : null,
    isAuthor,
    owned,
    priceAll: book.price_all,
    paidCheckoutAvailable,
  });
  const usePok = resolveActiveCheckoutProvider({
    newCheckoutRegime: process.env.NEW_CHECKOUT_REGIME,
    ledgerPaymentProvider: process.env.LEDGER_PAYMENT_PROVIDER,
  }) === "pok";
  // ALL-WIRING-2: the displayed price is a pure function of this book's
  // own `price_all` and nothing else. The environment-variable branch
  // that used to choose the currency here is GONE: which payment
  // provider a deployment has configured was never a fact about what
  // this book costs, and reading `usePok` to pick between a "$" and an
  // "ALL" rendering of the SAME legacy `price_cents` number meant the
  // very same row displayed as two different amounts depending on a
  // deployment setting. `usePok` survives below, where it belongs --
  // describing the checkout, not the price.
  //
  // Three outcomes, never two: "Price unavailable" for a row with no
  // authored ALL price, "Free" for 0, and the lek amount otherwise.
  const formattedPrice = formatCatalogPriceLabel(book.price_all);

  // STALE-CHECKOUT-1: the held-quote notice. buyBook redirects here with
  // ?checkout_conflict=<intent id> when the reader has an unresolved
  // paid attempt whose frozen economics no longer match what this page
  // would quote today (a price change, or a promo code they just typed).
  //
  // Everything shown about that quote is read back HERE, server-side,
  // from the exact intent id, through get_book_checkout_quote -- which
  // enforces auth.uid() ownership and the book id inside SECURITY
  // DEFINER, so a foreign or mismatched id returns no rows and this
  // renders nothing at all. The amount is never taken from the query
  // string, and the id is validated as a UUID before it is used, so a
  // crafted link can neither display a false price nor point the resume
  // form at someone else's intent.
  //
  // ALL-WIRING-2 CORRECTION (Codex finding 1): every checkout-resume
  // surface on this page is gated on THIS one named condition, computed
  // once and used at all three sites below.
  //
  // PurchasePanel already refused to render an acquisition control for a
  // book with no authored ALL price -- but the held-quote notice and the
  // lapsed-checkout notice are rendered OUTSIDE that panel, so an
  // authenticated non-owner could open a null-priced book with a valid
  // ?checkout_conflict=<uuid> and still be shown a frozen amount, a
  // resume form and a "Continue that checkout" button. That is an
  // acquisition surface on a book the storefront has declared
  // unavailable, which is exactly what the null-price rule forbids.
  //
  // `paid-unowned` is the ONLY state in which resuming a paid checkout
  // is a coherent offer: an author, an owner, an anonymous visitor, a
  // free book and an unpriced book each have no paid checkout of their
  // own to continue.
  //
  // PAID-CHECKOUT-SURFACE-1: and because resolveBookPurchaseState() only
  // returns `paid-unowned` while paid checkout is OPEN, this same one
  // condition also closes the quote lookup, the resume form and the
  // lapsed-checkout notice whenever canStartPaidCheckout() is false. No
  // second condition is added at any of the three sites.
  const canResumePaidCheckout = purchaseState === "paid-unowned";

  const conflictIntentId =
    typeof checkoutConflict === "string" && UUID_PATTERN.test(checkoutConflict)
      ? checkoutConflict
      : null;
  let heldQuote: HeldQuote | null = null;
  // The gate is on the LOOKUP, not only on the rendering: an unavailable
  // book must not even call get_book_checkout_quote. The rendering is
  // gated again below as defence in depth.
  if (conflictIntentId && user && canResumePaidCheckout) {
    const { data: quoteRows } = await supabase.rpc("get_book_checkout_quote", {
      p_intent_id: conflictIntentId,
      p_book_id: book.id,
    });
    const row = (quoteRows as HeldQuote[] | null)?.[0];
    // Only a still-unresolved attempt gets the resume form. A quote that
    // has since been fulfilled, completed, superseded or expired is
    // stale UI, not an offer -- the reader simply buys again.
    if (row && row.quote_state === "unresolved_conflict") heldQuote = row;
  }

  // See resolveShowSample's own comment (src/lib/book-purchase.ts) for
  // the full rule -- omitted for "owned"/"author" (who already have
  // Download EPUB), shown otherwise, identically regardless of whether
  // this book's manuscript was uploaded directly as an EPUB or
  // converted from DOCX.
  const showSample = resolveShowSample(purchaseState);

  const authorAvatarUrl = book.profiles?.avatar_path
    ? supabase.storage.from("avatars").getPublicUrl(book.profiles.avatar_path).data.publicUrl
    : null;

  // REDESIGN STEP 3 (P2): the existing purchase sentence, as the price
  // card's footnote. Shown in the same purchase states as before.
  const showPurchaseNote =
    purchaseState === "anonymous-paid" ||
    purchaseState === "anonymous-free" ||
    purchaseState === "anonymous-unavailable" ||
    purchaseState === "paid-unowned" ||
    purchaseState === "free-unowned" ||
    purchaseState === "unavailable-unowned";
  const checkoutSecurityNote = resolveCheckoutSecurityNote({
    priceAll: book.price_all,
    usePok,
    paidCheckoutAvailable,
  });
  const authorName = resolvePublicAuthorName(book.profiles);

  return (
    <main className="mx-auto w-full max-w-wide flex-1 px-4 pt-6 pb-16 sm:px-6">
      {/* REDESIGN STEP 3 (P1): Bookstore › Genre › Title. */}
      <nav aria-label="Breadcrumb" className="text-sm text-muted">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <li>
            <Link href="/bookstore" className={BREADCRUMB_LINK_CLASSES}>
              Bookstore
            </Link>
          </li>
          {book.genre && (
            <>
              <li aria-hidden="true">›</li>
              <li>
                <Link
                  href={buildBookstoreHref({}, { genre: book.genre })}
                  className={BREADCRUMB_LINK_CLASSES}
                >
                  {book.genre}
                </Link>
              </li>
            </>
          )}
          <li aria-hidden="true">›</li>
          <li aria-current="page" className="min-w-0 truncate">
            {book.title}
          </li>
        </ol>
      </nav>

      {/* ============================================================
          Main Book Hero -- REDESIGN STEP 3 (P2): two columns, stacked on
          phones. Left: the large cover and Read sample. Right: the
          title block, the white price card, and the book's own text.
          ============================================================ */}
      <div className="mt-6 flex flex-col gap-8 md:flex-row md:items-start md:gap-12">
        <div className="mx-auto flex w-56 shrink-0 flex-col gap-4 sm:w-64 md:mx-0 md:w-72 lg:w-80">
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coverUrl}
              alt={`${book.title} cover`}
              className="aspect-[2/3] w-full rounded-[3px] object-cover shadow-[0_18px_36px_rgba(30,58,50,0.25)]"
            />
          ) : (
            <CoverPlaceholder
              title={book.title}
              authorName={authorName}
              className="aspect-[2/3] w-full rounded-[3px] shadow-[0_18px_36px_rgba(30,58,50,0.25)]"
            />
          )}
          {/* See resolveShowSample's own comment (src/lib/book-purchase.ts):
              omitted for "owned"/"author", who already have Download EPUB. */}
          {showSample && (
            <div className="flex flex-col [&>button]:w-full [&>button]:rounded-[3px] [&>button]:border-primary [&>button]:py-3 [&>button]:font-semibold [&>button]:text-primary">
              <BookSampleReader bookId={book.id} bookTitle={book.title} />
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold uppercase tracking-[0.12em] text-[#806510]">
            {book.genre ? `${book.genre} · Ebook` : "Ebook"}
          </p>
          <h1 className="mt-3 font-serif text-4xl leading-[1.08] font-normal text-primary sm:text-5xl">
            {book.title}
          </h1>
          {/* LIBRUM 2.0 PUBLISHING-UX-1 PART D: rendered as its own,
              visually secondary element -- never joined into the h1's
              own text -- so a screen reader's page-title/heading
              structure stays exactly "book.title," matching every
              existing consumer of this page's <h1> (generateMetadata's
              own title is unaffected too; see this file's own note on
              why that's deliberately left alone). Omitted entirely
              when null, same "render nothing, not an empty row" rule
              every other optional field on this page already follows. */}
          {book.subtitle && (
            <p className="mt-2 font-serif text-xl text-muted italic">{book.subtitle}</p>
          )}

          {/* REDESIGN STEP 3: author and series on one line, as in the
              mockup ("by <author> · Book 1 of <series>"). */}
          <p className="mt-4 text-foreground">
            by{" "}
            <Link href={`/authors/${book.author_id}`} className={INLINE_LINK_CLASSES}>
              {authorName}
            </Link>
            {seriesInfo && (
              <>
                {" · "}
                {book.series_position ? `Book ${book.series_position} of ` : "Part of "}
                <Link href={`/series/${seriesInfo.id}`} className={INLINE_LINK_CLASSES}>
                  {seriesInfo.title}
                </Link>
              </>
            )}
          </p>

          {contributors && contributors.length > 0 && (
            <p className="mt-1 text-sm text-muted">
              {contributors
                .map(
                  (c) =>
                    `${CONTRIBUTOR_ROLE_VERB[c.role as keyof typeof CONTRIBUTOR_ROLE_VERB] ?? c.role} ${c.name}`,
                )
                .join(" · ")}
            </p>
          )}

          <div className="mt-3 flex items-center gap-2.5 text-[0.9375rem]">
            {/* FIX1 (X4): no star row (and no "0 out of 5 stars" for
                screen readers) until the first review; the words stay. */}
            {reviewCount > 0 && <StarRating rating={averageRating} />}
            <span className="text-muted">
              {reviewCount > 0
                ? `${averageRating.toFixed(1)} · ${reviewCount} review${reviewCount === 1 ? "" : "s"}`
                : "No reviews yet"}
            </span>
          </div>

          {/* REDESIGN STEP 3 (P2): the purchase panel as a white card --
              a large price, a full-width primary action, the secondary
              action under it, and the purchase sentence as a footnote. */}
          <div className="mt-6 flex max-w-[32.5rem] flex-col gap-4 rounded-[4px] border border-border bg-surface p-5 sm:p-6">
            <span className="font-serif text-4xl text-primary">{formattedPrice}</span>

            <PurchasePanel
              state={purchaseState}
              bookId={book.id}
              formattedPrice={formattedPrice}
              wishlisted={wishlisted}
            />

            {showPurchaseNote &&
              (purchaseState === "anonymous-unavailable" ||
              purchaseState === "unavailable-unowned" ? (
                // ALL-WIRING-2: three-way, same classification the
                // purchase state above used. The unavailable copy makes
                // no promise about acquiring the book, because there is
                // no acquisition form on the page in that state.
                <p className="text-sm text-muted">
                  This book doesn&apos;t have a price yet, so it can&apos;t be bought or downloaded right now.
                </p>
              ) : book.price_all === 0 ? (
                <p className="text-sm text-muted">
                  Free — no payment required. You&apos;ll get a DRM-free EPUB you can download anytime from your Librum Library.
                  {checkoutSecurityNote}
                </p>
              ) : (
                // REDESIGN STEP 3 (Renato D4): the mockup's three lines
                // for a paid book. RELEASE CHECK: the POK app line must
                // be true in our checkout before any Production release.
                <ul className="flex flex-col gap-1.5 text-sm text-muted">
                  <li>EPUB, no DRM. Read on your phone, tablet or e-reader.</li>
                  <li>Download anytime from your Librum library.</li>
                  <li>Pay by card or with the POK app.</li>
                  {checkoutSecurityNote && <li>{checkoutSecurityNote.trim()}</li>}
                </ul>
              ))}

            {purchaseState === "owned" && book.status !== "published" && (
              <p className="text-sm font-medium text-amber-700">
                This book is no longer available for sale. You can still
                download your copy anytime.
              </p>
            )}
          </div>

          {purchase === "success" && (
            <p className="mt-4 max-w-[32.5rem] rounded-[3px] bg-green-50 px-3 py-2 text-sm text-green-700">
              {owned ? (
                <>
                  Purchase complete — thank you!{" "}
                  <Link href="/library" className="focus-ring rounded-sm font-medium underline">
                    Go to your library
                  </Link>{" "}
                  to download it anytime.
                </>
              ) : (
                "Purchase complete — thank you! It may take a few seconds to show as owned below."
              )}
            </p>
          )}
          {freeStatus === "success" && (
            <p className="mt-4 max-w-[32.5rem] rounded-[3px] bg-green-50 px-3 py-2 text-sm text-green-700">
              {owned ? (
                <>
                  Added to your library!{" "}
                  <Link href="/library" className="focus-ring rounded-sm font-medium underline">
                    Go to your library
                  </Link>{" "}
                  to download it anytime.
                </>
              ) : (
                "Added to your library! It may take a few seconds to show as owned below."
              )}
            </p>
          )}
          {reviewStatus === "success" && (
            <p className="mt-4 max-w-[32.5rem] rounded-[3px] bg-green-50 px-3 py-2 text-sm text-green-700">
              Thanks for your review!
            </p>
          )}
          {reportStatus === "success" && (
            <p className="mt-4 max-w-[32.5rem] rounded-[3px] bg-green-50 px-3 py-2 text-sm text-green-700">
              Thanks — we&apos;ve received your report and will take a look.
            </p>
          )}
          {/* STALE-CHECKOUT-1: the held-quote conflict notice. It states
              the frozen amount, says plainly that today's price and any
              code just entered are NOT applied to it, and offers the
              deliberate resume as its own separate form -- never as a
              silent continuation of the buy button, which is how a
              reader would otherwise be charged an amount they never
              agreed to. */}
          {heldQuote && canResumePaidCheckout && (
            <div className="mt-4 max-w-[32.5rem] rounded-[3px] bg-amber-50 px-3 py-2 text-sm text-amber-800">
              <p className="font-medium">
                You already have a checkout in progress for this book.
              </p>
              <p className="mt-1">
                It is held at{" "}
                <strong>
                  {/* ALL-TXN-CURRENCY-4: a FROZEN checkout amount, in the
                      intent's own frozen currency -- never "any non-ALL
                      currency is dollars". */}
                  {formatTransactionAmount(
                    heldQuote.price_cents_at_checkout,
                    provenanceFromStoredCurrency(heldQuote.currency),
                  )}
                </strong>
                . That is the amount you would pay. Today&apos;s price and any
                promo code you just entered are <strong>not</strong> applied to
                it.
              </p>
              <p className="mt-1">
                You can finish that checkout, or wait for it to lapse and start
                a new one at the current price.
              </p>
              <form
                action={buyBook.bind(null, book.id)}
                className="mt-2 flex flex-wrap items-center gap-2"
              >
                <input type="hidden" name="resume_existing" value="1" />
                <input
                  type="hidden"
                  name="expected_intent_id"
                  value={heldQuote.intent_id}
                />
                <button type="submit" className={buttonClasses("primary", "sm")}>
                  Continue that checkout
                </button>
              </form>
            </div>
          )}
          {/* The accepted quote lapsed between the notice being rendered
              and the reader pressing Continue. Deliberately NOT
              auto-minted into a fresh one: that would silently move the
              reader onto a different price they never saw. */}
          {/* ALL-WIRING-2 CORRECTION: gated on the same condition. This
              notice ends with "You can start a new one at the current
              price", which is simply false on a book that has no current
              purchasable price -- and on an unavailable book it would also
              be an invitation to start a checkout the page refuses to
              offer. */}
          {checkoutExpired === "1" && canResumePaidCheckout && (
            <p className="mt-4 max-w-[32.5rem] rounded-[3px] bg-amber-50 px-3 py-2 text-sm text-amber-800">
              That checkout lapsed before it could be resumed, so nothing was
              charged. You can start a new one at the current price.
            </p>
          )}
          {/* QA-FIX-2: POK sends both a cancel and a failed payment here,
              so the text claims neither a charge nor its absence. Hidden
              once the book is owned (e.g. a later retry succeeded), where
              it would contradict the page. */}
          {canceled === "true" && !owned && (
            <p
              role="status"
              className="mt-4 max-w-[32.5rem] rounded-[3px] bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              Payment was cancelled or did not go through. You can try again
              whenever you&apos;re ready.
            </p>
          )}
          {error && (
            <p className="mt-4 max-w-[32.5rem] rounded-[3px] bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}

          {/* ============================================================
              About this book
              ============================================================ */}
          {/* LIBRUM 2.0 PRODUCT-1: the old preview_text "Look inside"
              accordion and the raw keywords pill list are both retired from
              this reader-facing section -- see the PRODUCT-1 audit. Neither
              field is dropped from the schema or from the Publishing
              Studio's own edit form; preview_text remains internally/
              backward-compatibly available (still editable there, still
              part of the pre-publish recommended checklist), and keywords
              still drive bookstore/author search exactly as before. This
              section now shows only the real description, plus a quiet
              Read Sample entry point (independent of, and in addition to,
              the hero CTA) when the reader doesn't already have full
              access. */}
          {book.description && (
            <section className="mt-10">
              <h2 className={SECTION_HEADING}>About this book</h2>
              <p className="mt-4 max-w-[42.5rem] leading-relaxed whitespace-pre-line text-foreground/90">
                {book.description}
              </p>
              {showSample && (
                <div className="mt-4">
                  <BookSampleReader bookId={book.id} bookTitle={book.title} variant="text" />
                </div>
              )}
            </section>
          )}

          {/* ============================================================
              Book Details
              ============================================================ */}
          <section className="mt-10">
            <h2 className={SECTION_HEADING}>Book details</h2>
            {/* REDESIGN STEP 3 (P3/D5): a light grid card, as in the
                mockup. Every row is unchanged: Format and Genre remain
                always/near-always present (genre is required at
                creation); every other row -- Series, ISBN, and
                (LIBRUM 2.0 PUBLISHING-UX-1 PART D) Language/Publisher/
                Edition/Originally published/Published on Librum --
                renders only when the book actually carries a real,
                authoritative value. No field here is ever guessed,
                defaulted, or substituted -- e.g. Publisher never falls
                back to "Librum" or the author's own name; it renders
                only book.publisher itself, or not at all. */}
            <dl className="mt-4 grid max-w-[42.5rem] grid-cols-2 gap-x-6 gap-y-5 rounded-[4px] border border-border bg-surface p-5 sm:grid-cols-3">
              <div>
                <dt className={DETAIL_LABEL_CLASSES}>Format</dt>
                <dd className={DETAIL_VALUE_CLASSES}>Ebook · EPUB</dd>
              </div>
              {book.language && (
                <div>
                  <dt className={DETAIL_LABEL_CLASSES}>Language</dt>
                  <dd className={DETAIL_VALUE_CLASSES}>{getLanguageLabel(book.language)}</dd>
                </div>
              )}
              {book.genre && (
                <div>
                  <dt className={DETAIL_LABEL_CLASSES}>Genre</dt>
                  <dd className={DETAIL_VALUE_CLASSES}>{book.genre}</dd>
                </div>
              )}
              {seriesInfo && (
                <div>
                  <dt className={DETAIL_LABEL_CLASSES}>Series</dt>
                  <dd className={DETAIL_VALUE_CLASSES}>
                    {book.series_position ? `Book ${book.series_position} of ` : ""}
                    <Link href={`/series/${seriesInfo.id}`} className={INLINE_LINK_CLASSES}>
                      {seriesInfo.title}
                    </Link>
                  </dd>
                </div>
              )}
              {book.publisher && (
                <div>
                  <dt className={DETAIL_LABEL_CLASSES}>Publisher</dt>
                  <dd className={DETAIL_VALUE_CLASSES}>{book.publisher}</dd>
                </div>
              )}
              {book.edition && (
                <div>
                  <dt className={DETAIL_LABEL_CLASSES}>Edition</dt>
                  <dd className={DETAIL_VALUE_CLASSES}>{book.edition}</dd>
                </div>
              )}
              {book.original_publication_date && (
                <div>
                  <dt className={DETAIL_LABEL_CLASSES}>Originally published</dt>
                  <dd className={DETAIL_VALUE_CLASSES}>
                    {formatDateOnly(book.original_publication_date)}
                  </dd>
                </div>
              )}
              {/* LIBRUM 2.0 PUBLISHING-UX-1 PART D: published_at only --
                  never created_at/updated_at, which mean something entirely
                  different (row creation/last edit, not "first went live").
                  Requires BOTH a published book AND a real published_at --
                  a legacy book published before migration 044 existed has
                  status="published" but published_at=null (performPublish()
                  only ever sets it going forward, no backfill -- see that
                  migration's own comment), and this row is omitted for
                  exactly that book rather than guessing a date it doesn't
                  actually have. */}
              {book.status === "published" && book.published_at && (
                <div>
                  <dt className={DETAIL_LABEL_CLASSES}>Published on Librum</dt>
                  <dd className={DETAIL_VALUE_CLASSES}>
                    {formatTimestampAsDate(book.published_at)}
                  </dd>
                </div>
              )}
              {book.isbn && (
                <div>
                  <dt className={DETAIL_LABEL_CLASSES}>ISBN</dt>
                  <dd className={DETAIL_VALUE_CLASSES}>{book.isbn}</dd>
                </div>
              )}
            </dl>
          </section>
        </div>
      </div>

      {/* ============================================================
          About the Author -- REDESIGN STEP 3 (P3/B5): a white card with
          the photo, name, bio and the Follow button from the author's
          own page.
          ============================================================ */}
      <section className="mt-14">
        <h2 className={SECTION_HEADING}>About the author</h2>
        <div className="mt-4 flex flex-wrap items-center gap-6 rounded-[4px] border border-border bg-surface p-6 sm:p-7">
          {authorAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={authorAvatarUrl}
              alt=""
              className="size-20 shrink-0 rounded-full object-cover sm:size-[5.5rem]"
            />
          ) : (
            <div className="size-20 shrink-0 rounded-full bg-[#d9e2dc] sm:size-[5.5rem]" />
          )}
          <div className="min-w-0 flex-[1_1_20rem]">
            <p className="font-serif text-[1.375rem] text-primary">{authorName}</p>
            {book.profiles?.bio && (
              <p className="mt-2 max-w-prose leading-relaxed text-muted">{book.profiles.bio}</p>
            )}
            <Link
              href={`/authors/${book.author_id}`}
              className="focus-ring mt-3 inline-block rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
            >
              View author profile &rarr;
            </Link>
          </div>
          {!isAuthor &&
            (user ? (
              <form
                action={(isFollowingAuthor ? unfollowAuthorFromBook : followAuthorFromBook).bind(
                  null,
                  book.author_id,
                  book.id,
                )}
              >
                <button
                  type="submit"
                  className={buttonClasses(
                    isFollowingAuthor ? "outline" : "primary",
                    "md",
                    "rounded-[3px] px-5 py-3 font-semibold",
                  )}
                >
                  {isFollowingAuthor ? "Following" : "Follow"}
                </button>
              </form>
            ) : (
              // The author page's own "Log in to follow" link, unchanged:
              // after logging in the reader follows from that page.
              <Link
                href={`/login?next=/authors/${book.author_id}`}
                className={buttonClasses("outline", "md", "rounded-[3px] border-primary px-5 py-3 font-semibold")}
              >
                Log in to follow
              </Link>
            ))}
        </div>
      </section>

      {/* ============================================================
          Reviews
          ============================================================ */}
      <section className="mt-14">
        <h2 className={SECTION_HEADING}>Reviews</h2>

        {owned && (
          <form
            action={submitReview.bind(null, book.id)}
            className="mt-4 flex max-w-[42.5rem] flex-col gap-3 rounded-[4px] border border-border bg-surface p-5"
          >
            <p className="text-sm font-medium">
              {myReview ? "Update your review" : "Leave a review"}
            </p>
            <label className="flex flex-col gap-1 text-sm">
              Rating
              <select
                name="rating"
                required
                defaultValue={myReview?.rating ?? ""}
                className="focus-ring rounded-[3px] border border-[#8c8472] bg-surface px-3 py-2"
              >
                <option value="" disabled>
                  Choose a rating
                </option>
                <option value="5">★★★★★</option>
                <option value="4">★★★★☆</option>
                <option value="3">★★★☆☆</option>
                <option value="2">★★☆☆☆</option>
                <option value="1">★☆☆☆☆</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Review (optional)
              <textarea
                name="body"
                rows={3}
                defaultValue={myReview?.body ?? ""}
                className="focus-ring rounded-[3px] border border-[#8c8472] bg-surface px-3 py-2"
              />
            </label>
            <button
              type="submit"
              className={buttonClasses("primary", "md", "w-fit rounded-[3px]")}
            >
              {myReview ? "Update review" : "Submit review"}
            </button>
          </form>
        )}

        {allReviews.length === 0 ? (
          <p className="mt-4 text-muted">No reviews yet.</p>
        ) : (
          <ul className="mt-6 flex max-w-[42.5rem] flex-col gap-4">
            {allReviews.map((review) => (
              <li key={review.id} className="border-t border-border pt-4">
                <div className="flex items-center gap-2">
                  <StarRating rating={review.rating} />
                  <span className="text-sm font-medium">
                    {resolvePublicAuthorName(review.profiles) ?? "A Librum reader"}
                  </span>
                </div>
                {review.body && (
                  <p className="mt-1 text-sm text-foreground/90">
                    {review.body}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ============================================================
          Series entries -- LIBRUM 2.0 PRODUCT-3: now also the home for
          "View series ->" (the one clear link to the new /series/[id]
          page from this section) and a Previous/Next continuity block,
          both derived from the exact same seriesEntries/orderSeriesBooks
          order this list itself already renders in -- never a second,
          differently-ordered query.
          ============================================================ */}
      {seriesInfo && seriesEntries.length > 1 && (
        <section className="mt-14 max-w-[42.5rem]">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className={SECTION_HEADING}>{seriesInfo.title}</h2>
            <Link
              href={`/series/${seriesInfo.id}`}
              className="focus-ring shrink-0 rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
            >
              View series &rarr;
            </Link>
          </div>

          {/* Previous/Next -- published-only (seriesEntries is already
              published-only), never wraps last -> first or first ->
              last. Absent entirely for a single-book series (this whole
              section already requires seriesEntries.length > 1) and
              renders nothing on whichever side has no neighbor. */}
          {(previousInSeries || nextInSeries) && (
            <div className="mt-4 flex flex-col gap-3 rounded-[4px] border border-border bg-surface p-4 sm:flex-row sm:items-start sm:justify-between">
              {previousInSeries ? (
                <Link
                  href={`/books/${previousInSeries.id}`}
                  className="focus-ring group flex flex-col rounded-sm"
                >
                  <span className="text-xs text-muted">&larr; Previous in series</span>
                  <span className="font-serif text-lg text-primary underline underline-offset-2 group-hover:decoration-2">
                    {previousInSeries.series_position != null
                      ? `Book ${previousInSeries.series_position} — `
                      : ""}
                    {previousInSeries.title}
                  </span>
                </Link>
              ) : (
                <span />
              )}
              {nextInSeries ? (
                <Link
                  href={`/books/${nextInSeries.id}`}
                  className="focus-ring group flex flex-col rounded-sm sm:items-end sm:text-right"
                >
                  <span className="text-xs text-muted">Next in series &rarr;</span>
                  <span className="font-serif text-lg text-primary underline underline-offset-2 group-hover:decoration-2">
                    {nextInSeries.series_position != null
                      ? `Book ${nextInSeries.series_position} — `
                      : ""}
                    {nextInSeries.title}
                  </span>
                </Link>
              ) : (
                <span />
              )}
            </div>
          )}

          <ol className="mt-4 flex flex-col gap-2">
            {seriesEntries.map((entry) => (
              <li key={entry.id}>
                {entry.id === book.id ? (
                  <span className="font-medium">
                    {entry.series_position != null && `${entry.series_position}. `}
                    {entry.title}{" "}
                    <span className="text-xs text-muted">(this book)</span>
                  </span>
                ) : (
                  <Link href={`/books/${entry.id}`} className={INLINE_LINK_CLASSES}>
                    {entry.series_position != null && `${entry.series_position}. `}
                    {entry.title}
                  </Link>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* ============================================================
          More by this author / You might also like
          ============================================================ */}
      <BookShelf
        title={authorName ? `More by ${authorName}` : "More by this author"}
        books={moreByAuthor ?? []}
        supabase={supabase}
      />
      <BookShelf
        title="You might also like"
        books={youMightLike}
        supabase={supabase}
      />

      {/* ============================================================
          Report this book
          ============================================================ */}
      {user && !isAuthor && (
        <p className="mt-10 text-xs text-muted">
          <Link
            href={`/books/${book.id}/report`}
            className="focus-ring rounded-sm hover:underline"
          >
            Report this book
          </Link>
        </p>
      )}
    </main>
  );
}

// REDESIGN STEP 3: shared A2 classes for this page. Thin serif headings
// (Renato D6); links inside sentences underlined at rest (C1).
const SECTION_HEADING = "font-serif text-[1.625rem] leading-tight font-normal text-primary";
const INLINE_LINK_CLASSES =
  "focus-ring rounded-sm font-semibold text-primary underline underline-offset-2 hover:decoration-2";
const BREADCRUMB_LINK_CLASSES =
  "focus-ring rounded-sm underline underline-offset-2 hover:text-primary hover:decoration-2";
const DETAIL_LABEL_CLASSES = "text-xs font-medium uppercase tracking-wide text-muted";
const DETAIL_VALUE_CLASSES = "mt-1 font-semibold text-foreground";

// REDESIGN STEP 3 (B5): the author page's own follow/unfollow actions,
// unchanged, plus a refresh of this book page so the button shows the
// new state at once (those actions only refresh the author's page).
// Only rendered for a signed-in reader who is not the author.
async function followAuthorFromBook(authorId: string, bookId: string) {
  "use server";
  await followAuthor(authorId);
  revalidatePath(`/books/${bookId}`);
}

async function unfollowAuthorFromBook(authorId: string, bookId: string) {
  "use server";
  await unfollowAuthor(authorId);
  revalidatePath(`/books/${bookId}`);
}

// PAID-CHECKOUT-SURFACE-1: the one reader-facing sentence for a paid book
// while paid checkout is closed. Deliberately says nothing about why.
const PAID_CHECKOUT_UNAVAILABLE_NOTICE = "Buying this book isn't available yet.";

// REDESIGN STEP 3 (P2): full-width actions inside the price card -- the
// primary one large, the secondary one outlined under it.
const PRIMARY_ACTION_CLASSES = buttonClasses(
  "primary",
  "lg",
  "w-full rounded-[3px] py-4 text-[1.0625rem] font-semibold",
);
const SECONDARY_ACTION_CLASSES = buttonClasses(
  "outline",
  "md",
  "w-full rounded-[3px] border-[#8c8472] py-3 font-semibold",
);
const STATUS_PILL_CLASSES = "rounded-[3px] bg-surface-hover px-4 py-3 text-sm font-medium";

// ============================================================
// Purchase / ownership action, by state -- see resolveBookPurchaseState
// (src/lib/book-purchase.ts) for the pure classification this switches
// on. Every form/link below binds the exact same server actions that
// existed before this pass (buyBook, getFreeBook) -- no purchase
// business logic changes here, only which of these five branches
// renders and how it's styled. REDESIGN STEP 3: Read sample moved out
// of this panel to under the cover (shown by the same showSample rule).
// ============================================================

function PurchasePanel({
  state,
  bookId,
  formattedPrice,
  wishlisted,
}: {
  state: BookPurchaseState;
  bookId: string;
  formattedPrice: string;
  wishlisted: boolean;
}) {
  const wishlistForm = (
    <form action={(wishlisted ? removeFromWishlist : addToWishlist).bind(null, bookId)}>
      <button type="submit" className={SECONDARY_ACTION_CLASSES}>
        {wishlisted ? "Remove from wishlist" : "Save for later"}
      </button>
    </form>
  );

  if (state === "author") {
    return (
      <div className="flex flex-col gap-3">
        <span className="text-sm text-muted">This is your book</span>
        <Link href={`/dashboard/books/${bookId}/edit`} className={PRIMARY_ACTION_CLASSES}>
          Manage book
        </Link>
        <a href={`/api/books/${bookId}/download`} className={SECONDARY_ACTION_CLASSES}>
          Download EPUB
        </a>
      </div>
    );
  }

  if (state === "owned") {
    return (
      <div className="flex flex-col gap-3">
        <span className={STATUS_PILL_CLASSES}>You own this book</span>
        <a href={`/api/books/${bookId}/download`} className={PRIMARY_ACTION_CLASSES}>
          Download EPUB
        </a>
      </div>
    );
  }

  // ALL-WIRING-2: a book with no authored ALL price renders NEITHER
  // acquisition form -- no buy form, no free-acquisition form, and not
  // the logged-out "Log in to buy" / "Log in to get this book" links
  // either, since both are promises the page cannot keep. Placed before
  // every other unowned branch so no later ternary can fall through to
  // a purchase control. Read Sample still shows (under the cover), and
  // so does the wishlist action for a signed-in reader: saving a book
  // for later is exactly the right thing to offer when it is not yet
  // obtainable.
  if (state === "anonymous-unavailable") {
    return (
      <div className="flex flex-col gap-3">
        <span className={`${STATUS_PILL_CLASSES} text-muted`}>Not available right now</span>
      </div>
    );
  }

  if (state === "unavailable-unowned") {
    return (
      <div className="flex flex-col gap-3">
        <span className={`${STATUS_PILL_CLASSES} text-muted`}>Not available right now</span>
        {wishlistForm}
      </div>
    );
  }

  // PAID-CHECKOUT-SURFACE-1: a paid book while paid checkout is closed.
  // The price stays visible above; here there is one neutral notice that
  // is not a control and names no provider, variable or reason, and none
  // of "Log in to buy", the promo field, the Buy form or any resume
  // surface. Save-for-later (signed-in only, as before) and the sample
  // remain.
  if (state === "anonymous-paid-checkout-closed" || state === "paid-unowned-checkout-closed") {
    return (
      <div className="flex flex-col gap-3">
        <p data-checkout-unavailable-notice="" className={`${STATUS_PILL_CLASSES} text-muted`}>
          {PAID_CHECKOUT_UNAVAILABLE_NOTICE}
        </p>

        {state === "paid-unowned-checkout-closed" && wishlistForm}
      </div>
    );
  }

  if (state === "anonymous-paid" || state === "anonymous-free") {
    return (
      <div className="flex flex-col gap-3">
        <Link href={`/login?next=/books/${bookId}`} className={PRIMARY_ACTION_CLASSES}>
          {state === "anonymous-free" ? "Log in to get this book" : "Log in to buy"}
        </Link>
      </div>
    );
  }

  // free-unowned / paid-unowned: a real reader, not the author, doesn't
  // already own it -- the only two states where a purchase/acquisition
  // form and the secondary wishlist action both apply.
  return (
    <div className="flex flex-col gap-3">
      {state === "free-unowned" ? (
        <form action={getFreeBook.bind(null, bookId)}>
          <button type="submit" className={PRIMARY_ACTION_CLASSES}>
            Get ebook — Free
          </button>
        </form>
      ) : (
        <form action={buyBook.bind(null, bookId)} className="flex flex-col gap-3">
          <input
            name="code"
            type="text"
            aria-label="Promo code (optional)"
            placeholder="Promo code (optional)"
            className="focus-ring w-full rounded-[3px] border border-[#8c8472] bg-surface px-3 py-2.5 text-sm"
          />
          <button type="submit" className={PRIMARY_ACTION_CLASSES}>
            Buy ebook — {formattedPrice}
          </button>
        </form>
      )}

      {wishlistForm}
    </div>
  );
}
