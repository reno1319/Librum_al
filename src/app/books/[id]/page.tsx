import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  buyBook,
  getFreeBook,
  submitReview,
  addToWishlist,
  removeFromWishlist,
} from "./actions";
import { StarRating } from "@/components/star-rating";
import { BookShelf } from "@/components/book-shelf";
import { BookSampleReader } from "@/components/book-sample-reader";
import { CONTRIBUTOR_ROLE_VERB } from "@/lib/contributor-roles";
import { formatPrice } from "@/lib/pricing";
import { resolveBookPurchaseState, resolveShowSample, type BookPurchaseState } from "@/lib/book-purchase";
import { orderSeriesBooks, resolveSeriesNeighbors } from "@/lib/series-order";
import { buttonClasses } from "@/components/ui/button";
import type { Book, Profile, Review, Series, Contributor } from "@/lib/types";

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
// section's avatar thumbnail) on top of the `display_name` every other
// book-with-author query on this page already selects -- kept as its
// own type, distinct from BookWithAuthor below, so the shelf queries
// (which only ever need display_name) aren't forced to also carry
// fields they never fetch. Extending this one existing joined select
// (rather than adding a second, sequential profile query) is exactly
// what PERF-1's own concurrency work calls for reusing.
type BookWithAuthorBio = Book & {
  profiles: Pick<Profile, "display_name" | "bio" | "avatar_path"> | null;
};
type BookWithAuthor = Book & { profiles: Pick<Profile, "display_name"> | null };
// LIBRUM 2.0 PRODUCT-3: `created_at` added to what this already-existing
// query selects (no new query, no new PERF-1 batch member) so
// orderSeriesBooks() -- shared with the public Series page -- has the
// same deterministic tie-break data here that it has there. The `.order()`
// call below stays as a DB-level head start; orderSeriesBooks() is the
// actual authoritative order both surfaces agree on.
type SeriesEntry = Pick<Book, "id" | "title" | "series_position" | "created_at">;
type ReviewWithReader = Review & {
  profiles: Pick<Profile, "display_name"> | null;
};

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
    .select("*, profiles(display_name, bio, avatar_path)")
    .eq("id", id)
    .single<BookWithAuthorBio>();
  return book;
});

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
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
  }>;
}) {
  const { id } = await params;
  const {
    purchase,
    free: freeStatus,
    review: reviewStatus,
    report: reportStatus,
    error,
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
  ] = await Promise.all([
    supabase
      .from("reviews")
      .select("*, profiles(display_name)")
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
    book.series_id
      ? supabase
          .from("books")
          .select("id, title, series_position, created_at")
          .eq("series_id", book.series_id)
          .eq("status", "published")
          .order("series_position", { ascending: true, nullsFirst: false })
          .returns<SeriesEntry[]>()
      : Promise.resolve({ data: null }),
    supabase
      .from("books")
      .select("*, profiles(display_name)")
      .eq("status", "published")
      .eq("author_id", book.author_id)
      .neq("id", id)
      .order("created_at", { ascending: false })
      .limit(8)
      .returns<BookWithAuthor[]>(),
    book.genre
      ? supabase
          .from("books")
          .select("*, profiles(display_name)")
          .eq("status", "published")
          .eq("genre", book.genre)
          .neq("id", id)
          .neq("author_id", book.author_id)
          .order("created_at", { ascending: false })
          .limit(8)
          .returns<BookWithAuthor[]>()
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

  const purchaseState = resolveBookPurchaseState({
    user: user ? { id: user.id } : null,
    isAuthor,
    owned,
    priceCents: book.price_cents,
  });
  const formattedPrice = formatPrice(book.price_cents);

  // See resolveShowSample's own comment (src/lib/book-purchase.ts) for
  // the full rule -- omitted for "owned"/"author" (who already have
  // Download EPUB), shown otherwise, identically regardless of whether
  // this book's manuscript was uploaded directly as an EPUB or
  // converted from DOCX.
  const showSample = resolveShowSample(purchaseState);

  const authorAvatarUrl = book.profiles?.avatar_path
    ? supabase.storage.from("avatars").getPublicUrl(book.profiles.avatar_path).data.publicUrl
    : null;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      {/* ============================================================
          Main Book Hero
          ============================================================ */}
      <div className="flex flex-col gap-8 sm:flex-row">
        <div className="mx-auto w-56 shrink-0 sm:mx-0 sm:w-72">
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={coverUrl}
              alt={`${book.title} cover`}
              className="aspect-[2/3] w-full rounded-lg object-cover shadow-sm"
            />
          ) : (
            <div className="aspect-[2/3] w-full rounded-lg bg-border" />
          )}
        </div>

        <div className="flex-1">
          {book.genre && (
            <span className="text-xs uppercase tracking-wide text-muted">
              {book.genre}
            </span>
          )}
          <h1 className="font-serif text-3xl font-semibold sm:text-4xl">{book.title}</h1>

          {seriesInfo && (
            <p className="mt-1 text-sm text-muted">
              {book.series_position ? `Book ${book.series_position} of ` : "Part of "}
              <Link
                href={`/series/${seriesInfo.id}`}
                className="focus-ring rounded-sm font-medium text-foreground hover:underline"
              >
                {seriesInfo.title}
              </Link>
            </p>
          )}

          <p className="mt-1 text-sm text-muted">
            by{" "}
            <Link
              href={`/authors/${book.author_id}`}
              className="focus-ring rounded-sm hover:underline"
            >
              {book.profiles?.display_name}
            </Link>
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

          <span className="mt-4 block text-2xl font-semibold text-primary">
            {formattedPrice}
          </span>

          <div className="mt-1 flex items-center gap-2 text-sm">
            <StarRating rating={averageRating} />
            <span className="text-muted">
              {reviewCount > 0
                ? `${averageRating.toFixed(1)} · ${reviewCount} review${reviewCount === 1 ? "" : "s"}`
                : "No reviews yet"}
            </span>
          </div>

          <div className="mt-4">
            <PurchasePanel
              state={purchaseState}
              bookId={book.id}
              bookTitle={book.title}
              formattedPrice={formattedPrice}
              wishlisted={wishlisted}
              showSample={showSample}
            />
          </div>

          {(purchaseState === "anonymous-paid" ||
            purchaseState === "anonymous-free" ||
            purchaseState === "paid-unowned" ||
            purchaseState === "free-unowned") && (
            <p className="mt-2 text-xs text-muted">
              {book.price_cents === 0
                ? "Free — no payment required. You'll get a DRM-free EPUB you can download anytime from your Librum Library."
                : "DRM-free EPUB. Download it anytime from your Librum Library."}
              {book.price_cents > 0 && " Secure checkout with Stripe."}
            </p>
          )}

          {purchaseState === "owned" && book.status !== "published" && (
            <p className="mt-2 text-xs font-medium text-amber-700">
              This book is no longer available for sale. You can still
              download your copy anytime.
            </p>
          )}

          {purchase === "success" && (
            <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
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
            <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
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
            <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
              Thanks for your review!
            </p>
          )}
          {reportStatus === "success" && (
            <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
              Thanks — we&apos;ve received your report and will take a look.
            </p>
          )}
          {error && (
            <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
              {error}
            </p>
          )}
        </div>
      </div>

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
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="font-serif text-xl font-semibold">About this book</h2>
          <p className="mt-4 max-w-prose whitespace-pre-line text-foreground/90">
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
      <section className="mt-12 border-t border-border pt-8">
        <h2 className="font-serif text-xl font-semibold">Book Details</h2>
        {/* LIBRUM 2.0 PRODUCT-1 PRE-COMMIT CORRECTION: previously plain
            labels floating in whitespace -- now a single compact,
            bordered/tinted editorial band, which is what actually reads
            as "an intentional metadata treatment" rather than an
            unfinished table, at every field count. flex-wrap (no
            reserved grid column tracks) means 2, 3, or 4 items always
            pack left-to-right with no dangling empty slot; the
            `:not(:last-child)` divider rule adapts automatically to
            however many fields this particular book actually has, never
            leaving a stray trailing rule after the true last item.
            Still only ever the same 4 already-trustworthy fields --
            Format and Genre are always present (genre is required at
            creation), Series/ISBN only when the book actually has one;
            no invented Publisher/Published date/Language/Edition/Page
            count/Reading time, since none of those exist authoritatively
            in this schema. */}
        <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-5 rounded-lg border border-border bg-surface px-6 py-5 sm:[&>div:not(:last-child)]:border-r sm:[&>div:not(:last-child)]:border-border sm:[&>div:not(:last-child)]:pr-8">
          <div className="min-w-28">
            <dt className="text-xs font-medium uppercase tracking-wide text-muted">Format</dt>
            <dd className="mt-1 text-sm font-medium text-foreground">Ebook · EPUB</dd>
          </div>
          {book.genre && (
            <div className="min-w-28">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">Genre</dt>
              <dd className="mt-1 text-sm font-medium text-foreground">{book.genre}</dd>
            </div>
          )}
          {seriesInfo && (
            <div className="min-w-28">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">Series</dt>
              <dd className="mt-1 text-sm font-medium text-foreground">
                {book.series_position ? `Book ${book.series_position} of ` : ""}
                <Link
                  href={`/series/${seriesInfo.id}`}
                  className="focus-ring rounded-sm hover:underline"
                >
                  {seriesInfo.title}
                </Link>
              </dd>
            </div>
          )}
          {book.isbn && (
            <div className="min-w-28">
              <dt className="text-xs font-medium uppercase tracking-wide text-muted">ISBN</dt>
              <dd className="mt-1 text-sm font-medium text-foreground">{book.isbn}</dd>
            </div>
          )}
        </dl>
      </section>

      {/* ============================================================
          About the Author
          ============================================================ */}
      <section className="mt-12 border-t border-border pt-8">
        <h2 className="font-serif text-xl font-semibold">About the Author</h2>
        <div className="mt-3 flex items-start gap-4">
          {authorAvatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={authorAvatarUrl}
              alt=""
              className="size-14 shrink-0 rounded-full object-cover sm:size-16"
            />
          ) : (
            <div className="size-14 shrink-0 rounded-full bg-border sm:size-16" />
          )}
          <div className="min-w-0">
            <p className="font-serif text-xl font-semibold text-foreground">
              {book.profiles?.display_name}
            </p>
            {book.profiles?.bio && (
              <p className="mt-2 max-w-prose text-sm text-foreground/90">{book.profiles.bio}</p>
            )}
            <Link
              href={`/authors/${book.author_id}`}
              className="focus-ring mt-3 inline-block rounded-sm text-sm font-medium text-primary hover:underline"
            >
              View author profile &rarr;
            </Link>
          </div>
        </div>
      </section>

      {/* ============================================================
          Reviews
          ============================================================ */}
      <section className="mt-12 border-t border-border pt-8">
        <h2 className="font-serif text-xl font-semibold">Reviews</h2>

        {owned && (
          <form
            action={submitReview.bind(null, book.id)}
            className="mt-4 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4 shadow-sm"
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
                className="focus-ring rounded-lg border border-border bg-surface px-3 py-2"
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
                className="focus-ring rounded-lg border border-border bg-surface px-3 py-2"
              />
            </label>
            <button
              type="submit"
              className={buttonClasses("primary", "md", "w-fit")}
            >
              {myReview ? "Update review" : "Submit review"}
            </button>
          </form>
        )}

        {allReviews.length === 0 ? (
          <p className="mt-4 text-sm text-muted">No reviews yet.</p>
        ) : (
          <ul className="mt-6 flex flex-col gap-4">
            {allReviews.map((review) => (
              <li key={review.id} className="border-t border-border pt-4">
                <div className="flex items-center gap-2">
                  <StarRating rating={review.rating} />
                  <span className="text-sm font-medium">
                    {review.profiles?.display_name}
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
        <section className="mt-12 border-t border-border pt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="font-serif text-xl font-semibold">{seriesInfo.title}</h2>
            <Link
              href={`/series/${seriesInfo.id}`}
              className="focus-ring shrink-0 rounded-sm text-sm font-medium text-primary hover:underline"
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
            <div className="mt-4 flex flex-col gap-3 border-y border-border py-4 sm:flex-row sm:items-start sm:justify-between">
              {previousInSeries ? (
                <Link
                  href={`/books/${previousInSeries.id}`}
                  className="focus-ring group flex flex-col rounded-sm"
                >
                  <span className="text-xs text-muted">&larr; Previous in series</span>
                  <span className="font-medium text-foreground group-hover:underline">
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
                  <span className="font-medium text-foreground group-hover:underline">
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

          <ol className="mt-4 flex flex-col gap-2 text-sm">
            {seriesEntries.map((entry) => (
              <li key={entry.id}>
                {entry.id === book.id ? (
                  <span className="font-medium">
                    {entry.series_position != null && `${entry.series_position}. `}
                    {entry.title}{" "}
                    <span className="text-xs text-muted">(this book)</span>
                  </span>
                ) : (
                  <Link
                    href={`/books/${entry.id}`}
                    className="focus-ring rounded-sm hover:underline"
                  >
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
        title={
          book.profiles?.display_name
            ? `More by ${book.profiles.display_name}`
            : "More by this author"
        }
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
        <p className="mt-8 text-xs text-muted">
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

// ============================================================
// Purchase / ownership action, by state -- see resolveBookPurchaseState
// (src/lib/book-purchase.ts) for the pure classification this switches
// on. Every form/link below binds the exact same server actions that
// existed before this pass (buyBook, getFreeBook) -- no purchase
// business logic changes here, only which of these five branches
// renders and how it's styled.
// ============================================================

function PurchasePanel({
  state,
  bookId,
  bookTitle,
  formattedPrice,
  wishlisted,
  showSample,
}: {
  state: BookPurchaseState;
  bookId: string;
  bookTitle: string;
  formattedPrice: string;
  wishlisted: boolean;
  showSample: boolean;
}) {
  if (state === "author") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted">This is your book</span>
        <Link
          href={`/dashboard/books/${bookId}/edit`}
          className={buttonClasses("primary", "md")}
        >
          Manage book
        </Link>
        <a
          href={`/api/books/${bookId}/download`}
          className={buttonClasses("outline", "md")}
        >
          Download EPUB
        </a>
      </div>
    );
  }

  if (state === "owned") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <span className="rounded-lg bg-surface-hover px-4 py-2 text-sm font-medium">
          You own this book
        </span>
        <a
          href={`/api/books/${bookId}/download`}
          className={buttonClasses("primary", "md")}
        >
          Download EPUB
        </a>
      </div>
    );
  }

  if (state === "anonymous-paid" || state === "anonymous-free") {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Link href={`/login?next=/books/${bookId}`} className={buttonClasses("primary", "md")}>
          {state === "anonymous-free" ? "Log in to get this book" : "Log in to buy"}
        </Link>
        {showSample && <BookSampleReader bookId={bookId} bookTitle={bookTitle} />}
      </div>
    );
  }

  // free-unowned / paid-unowned: a real reader, not the author, doesn't
  // already own it -- the only two states where a purchase/acquisition
  // form and the secondary wishlist action both apply.
  return (
    <div className="flex flex-wrap items-center gap-3">
      {state === "free-unowned" ? (
        <form action={getFreeBook.bind(null, bookId)}>
          <button type="submit" className={buttonClasses("primary", "md")}>
            Get ebook — Free
          </button>
        </form>
      ) : (
        <form action={buyBook.bind(null, bookId)} className="flex flex-wrap items-center gap-2">
          <input
            name="code"
            type="text"
            placeholder="Promo code (optional)"
            className="focus-ring w-40 rounded-md border border-border bg-surface px-3 py-2 text-sm"
          />
          <button type="submit" className={buttonClasses("primary", "md")}>
            Buy ebook — {formattedPrice}
          </button>
        </form>
      )}

      <form action={(wishlisted ? removeFromWishlist : addToWishlist).bind(null, bookId)}>
        <button type="submit" className={buttonClasses("outline", "sm")}>
          {wishlisted ? "Remove from wishlist" : "Save for later"}
        </button>
      </form>

      {showSample && <BookSampleReader bookId={bookId} bookTitle={bookTitle} />}
    </div>
  );
}
