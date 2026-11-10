import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { cache, Fragment } from "react";
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
import { followPenName, unfollowPenName } from "../../autore/[id]/actions";
import { notifyMeWhenOut, removePreorderNotice } from "./preorder-actions";
import {
  LISTED_BOOK_STATUSES,
  NOTIFY_HELP,
  NOTIFY_ME_LABEL,
  NOTIFY_ON_NOTICE,
  NOTIFY_REMOVE_LABEL,
  NOTIFY_SIGN_IN_LABEL,
  NOTIFY_STATUS_MESSAGES,
  PREORDER_PRICE_NOTE,
  isPreorder,
  preorderReleaseLabel,
  readNotifyStatus,
  tiranaToday,
} from "@/lib/preorder-reader";
import { buildBookstoreHref } from "@/lib/bookstore";
import { StarRating } from "@/components/star-rating";
import { BookShelf } from "@/components/book-shelf";
import { BookSampleReader } from "@/components/book-sample-reader";
import { latestApprovedReview, readReviewSnapshots } from "@/lib/book-reviews";
import { CONTRIBUTOR_ROLE_VERB } from "@/lib/contributor-roles";
import { getLanguageLabel } from "@/lib/languages";
import { BOOK_TYPE_LABEL, bookEyebrow, bookTypeOf } from "@/lib/book-types";
import { PAGE_ESTIMATE_LABEL, pageEstimateText } from "@/lib/page-estimate";
import { READING_TIME_LABEL, readingTimeText } from "@/lib/reading-time";
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
import { getAuthorInitials } from "@/lib/author-initials";
import {
  resolveBookByline,
  resolveBookPenName,
  resolveOriginalAuthor,
  resolveTranslatorLine,
} from "@/lib/book-byline";
import { PD_PREPARED_BY, readPdEditionRedirect, showsPreparedBy } from "@/lib/pd-editions";
import { readRightsBasisForPages } from "@/lib/librum-download-rights";
import {
  authorPagePath,
  penNameLinkKind,
  penNameLinkLabel,
  readPenNameLinks,
  type PenNameRef,
  type PublicPenName,
} from "@/lib/pen-names";
import { buttonClasses } from "@/components/ui/button";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import type { PublicBook, PublicReview, PublicSeries, Contributor } from "@/lib/types";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import { buyerDownloadNote, readMyDownloadStates, SHARING_REMINDER } from "@/lib/book-downloads";
import { bookWhatsappShareHref } from "@/lib/contact";
import { bookPagePath, buildBookJsonLd, canonicalMetadata, serializeJsonLd, siteOriginOrNull } from "@/lib/seo";
import { pageErrorMessage } from "@/lib/page-messages";
import { editorPath } from "@/lib/book-editor-copy";
import {
  ADULT_DETAIL_LABEL,
  ADULT_DETAIL_VALUE,
  EDITION_LABEL,
  READING_AGE_LABEL,
  bookCategories,
  categoriesLabel,
  descriptionSnippet,
  editionValue,
  isYoungReaderBook,
  readingAgeValue,
} from "@/lib/book-reader-details";
import { BookDescriptionView } from "@/components/book-description-view";
import { CopyLinkButton, CoverZoom, ExpandableText } from "@/components/book-page-extras";
import {
  IconCalendar,
  IconClock,
  IconDevice,
  IconFacebook,
  IconGlobe,
  IconInstagram,
  IconPage,
} from "@/components/icons";
import {
  ANONYMOUS_REVIEWER_NAME,
  AUTHOR_REVIEWER_LABEL,
  REVIEW_BODY_MAX,
  REVIEW_EDIT_WARNING,
  REVIEW_NAME_HELP,
  REVIEW_NAME_MAX,
  REVIEW_PENDING_NOTICE,
  REVIEW_RULES_NOTE,
  REVIEW_UNCHANGED_NOTICE,
  VERIFIED_PURCHASE_LABEL,
  ownReviewNotice,
  type OwnReview,
} from "@/lib/reader-reviews";

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
//
// PEN-NAMES-1 (migration 20261019184512): the book's own byline, "About
// the author" and "More by" now come from the BOOK'S PEN NAME (3a),
// embedded from the public_pen_names view as `pen` (no account
// columns); the shelves embed it too. Only the reviews join still reads
// public_author_profiles (out of scope here; PR B).
//
// PEN-NAMES-2: every public read on this page goes through the views
// (public_books, public_series, public_reviews), whose types carry no
// account column, so nothing here can render or serialise an account id.
// The author check is an own-row query on the base table.
type BookWithAuthorBio = PublicBook & {
  pen: PublicPenName | null;
};
type BookWithAuthor = PublicBook & {
  pen: PenNameRef | null;
};
// LIBRUM 2.0 PRODUCT-3: `created_at` added to what this already-existing
// query selects (no new query, no new PERF-1 batch member) so
// orderSeriesBooks() -- shared with the public Series page -- has the
// same deterministic tie-break data here that it has there. The `.order()`
// call below stays as a DB-level head start; orderSeriesBooks() is the
// actual authoritative order both surfaces agree on.
type SeriesEntry = Pick<PublicBook, "id" | "title" | "series_position" | "created_at">;
// The caller's own review, read from the base table (own-row policy).
// BD13: with its status and, when rejected, the reason and staff note.
type MyReview = OwnReview;

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
    .from("public_books")
    .select("*, pen:public_pen_names(id, name, bio, avatar_path, links)")
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
  // Falling back to the root layout's generic site metadata instead.
  //
  // PREVIEW-1 (A5, Renato 7a): plus noindex. Only the author (their
  // "Preview my book" page) and earlier buyers can open an unpublished
  // book's page, so a crawler never sees it anyway; this is extra safety.
  // BD16 P4 (D1): a pre-order is a public book page too.
  if (!book || (book.status !== "published" && !isPreorder(book))) {
    return { robots: { index: false, follow: false } };
  }

  // LIBRUM 2.0 SEO-1: `title` is the bare book title, deliberately NOT
  // suffixed here -- the root layout's "%s | Librum" title template
  // appends that automatically, so a manual suffix here would render as
  // "<title> | Librum | Librum". Open Graph's own title is a separate
  // field the template never touches, so it keeps its existing
  // "<title> — Librum" form unchanged (no Open Graph format change).
  const title = book.title;
  const ogTitle = `${book.title} — Librum`;
  // BD15 P8: the plain text of the rich description, never its marks.
  const plainDescription = descriptionSnippet(book.description);
  const description = plainDescription
    ? truncateForMetadata(plainDescription, METADATA_DESCRIPTION_MAX)
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
    ...canonicalMetadata(bookPagePath(book.id)),
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
    // BD16 P4: the "Më njofto" result (on / off / error), words only.
    notify?: string;
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
    error: rawError,
    checkout_conflict: checkoutConflict,
    checkout_expired: checkoutExpired,
    canceled,
    notify: rawNotify,
  } = await searchParams;
  const error = pageErrorMessage(rawError);

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

  // BD15 P7 (Q2 a): a public-domain edition Librum replaced with another
  // sends readers to the picked one (only when the page would otherwise
  // be "not found": its author and earlier readers still see it).
  const notFoundOrPickedEdition = async (): Promise<never> => {
    const picked = await readPdEditionRedirect(supabase, id);
    if (picked) redirect(`/libra/${picked}`);
    notFound();
  };

  if (!book) {
    return notFoundOrPickedEdition();
  }

  // PEN-NAMES-2: an own-row query, so the page never needs the book's
  // author_id (public_books has none). Works before and after the
  // contract: the base table only ever returns the caller's own row here.
  let isAuthor = false;
  if (user) {
    const { data: ownRow } = await supabase
      .from("books")
      .select("id")
      .eq("id", id)
      .eq("author_id", user.id)
      .maybeSingle();
    isAuthor = !!ownRow;
  }

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
  // BD16 P4 (D1): a live pre-order is public like a published book.
  const preorder = isPreorder(book);
  if (book.status !== "published" && !preorder && !isAuthor && !owned) {
    return notFoundOrPickedEdition();
  }

  // BD16 P4 ("Më njofto"): the reader's own row (RLS: own rows only).
  // Not for the author, and not for a reader who already owns the book
  // (an earlier buyer of a book that is now pre-ordered again).
  const notifyStatus = preorder ? readNotifyStatus(rawNotify) : null;
  let notifyOn = false;
  if (preorder && user && !isAuthor && !owned) {
    const { data: noticeRow } = await supabase
      .from("preorder_notify_requests")
      .select("book_cancelled_at")
      .eq("book_id", id)
      .eq("user_id", user.id)
      .maybeSingle<{ book_cancelled_at: string | null }>();
    notifyOn = !!noticeRow && noticeRow.book_cancelled_at === null;
  }
  const releaseLabel = preorder ? preorderReleaseLabel(book.release_date, tiranaToday()) : null;

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
  // BD3 patch 4 (audit r1, H1; Renato 16:37Z 1a): with an original
  // author, whether the pen name may be named as translator depends on
  // the rights basis, which only the author may read through RLS -- the
  // same service-role read of one column the download route makes.
  // Started here, awaited after the batch below; only for such a book.
  const rightsForBylinePromise = resolveOriginalAuthor(book)
    ? readRightsBasisForPages(createAdminClient(), book.id)
    : null;

  const [
    { data: reviews },
    { data: myReviewRow },
    { data: contributors },
    { data: seriesRow },
    { data: seriesEntriesData },
    { data: moreByAuthor },
    { data: youMightLikeData },
    { data: followRow },
    { count: penBookCount },
  ] = await Promise.all([
    // PEN-NAMES-2 (22a): reviews come from public_reviews -- no reader_id.
    // BD13: approved reviews only; reviewer_name is the chosen review name
    // or null, never a pen name; verified is the badge.
    supabase
      .from("public_reviews")
      .select("id, book_id, rating, body, created_at, reviewer_name, verified, reviewer_is_author")
      .eq("book_id", id)
      .order("created_at", { ascending: false })
      .returns<PublicReview[]>(),
    // The caller's own review, for the form's defaults: an own-row read.
    user
      ? supabase
          .from("reviews")
          .select("id, rating, body, status, rejection_reason, rejection_note")
          .eq("book_id", id)
          .eq("reader_id", user.id)
          .maybeSingle<MyReview>()
      : Promise.resolve({ data: null }),
    supabase
      .from("book_contributors")
      .select("*")
      .eq("book_id", id)
      .order("created_at")
      .returns<Contributor[]>(),
    book.series_id
      ? supabase
          .from("public_series")
          .select("id, title, pen_name_id, created_at")
          .eq("id", book.series_id)
          .maybeSingle<PublicSeries>()
      : Promise.resolve({ data: null }),
    // ALL-WIRING-2: all three of these lists are navigation/discovery --
    // "the rest of this series", "more by this author", "you might
    // like" -- so each excludes a book with no authored ALL price. Such
    // a row is not ALL-ready: it is neither free nor purchasable, so
    // offering it as a next thing to read would be an invitation the
    // storefront cannot honour. Its own detail page stays reachable.
    book.series_id
      ? supabase
          .from("public_books")
          .select("id, title, series_position, created_at")
          .eq("series_id", book.series_id)
          // BD16 P4 (D1): pre-orders are listed with the rest.
          .in("status", LISTED_BOOK_STATUSES)
          .not("price_all", "is", null)
          .order("series_position", { ascending: true, nullsFirst: false })
          .returns<SeriesEntry[]>()
      : Promise.resolve({ data: null }),
    // 3a: "More by" = only books under this book's pen name. BD15 P7: a
    // public-domain edition without the editor mention has none here.
    book.pen_name_id
      ? supabase
          .from("public_books")
          .select("*, pen:public_pen_names(id, name)")
          .in("status", LISTED_BOOK_STATUSES)
          .not("price_all", "is", null)
          .eq("pen_name_id", book.pen_name_id)
          .neq("id", id)
          .order("created_at", { ascending: false })
          .limit(8)
          .returns<BookWithAuthor[]>()
      : Promise.resolve({ data: null }),
    // BD15 P8 (Q2 a): books sharing ANY of this book's categories; on a
    // book for children or teens, never an 18+ book.
    bookCategories(book).length > 0
      ? (() => {
          let sameGenre = supabase
            .from("public_books")
            .select("*, pen:public_pen_names(id, name)")
            .in("status", LISTED_BOOK_STATUSES)
            .not("price_all", "is", null)
            .overlaps("categories", bookCategories(book))
            .neq("id", id);
          if (isYoungReaderBook(book)) sameGenre = sameGenre.eq("is_adult", false);
          // PEN-NAMES-2 (L15): leave out the same pen name only. Leaving
          // out the whole account would let two shelves be compared to
          // tell which pen names share an account. BD15 P7: a
          // public-domain edition without the editor mention shows no pen
          // name, so there is none to leave out.
          return book.pen_name_id ? sameGenre.neq("pen_name_id", book.pen_name_id) : sameGenre;
        })()
          .order("created_at", { ascending: false })
          .limit(8)
          .returns<BookWithAuthor[]>()
      : Promise.resolve({ data: null }),
    // REDESIGN STEP 3 (B5): whether this reader already follows the
    // book's pen name (PEN-NAMES-1, 4a), for the Follow button in About
    // the Author -- the same query the pen name's own page runs. Never
    // asked for the author themself or for a visitor who is not signed in.
    user && !isAuthor && book.pen_name_id
      ? supabase
          .from("pen_name_follows")
          .select("pen_name_id")
          .eq("follower_id", user.id)
          .eq("pen_name_id", book.pen_name_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    // P1 (design B): "N libra në Librum" under the author's name -- a
    // count only (no rows) of the very books "More by" may list: this
    // pen name's listed books with an authored ALL price, this one too.
    book.pen_name_id
      ? supabase
          .from("public_books")
          .select("id", { count: "exact", head: true })
          .in("status", LISTED_BOOK_STATUSES)
          .not("price_all", "is", null)
          .eq("pen_name_id", book.pen_name_id)
      : Promise.resolve({ count: null }),
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
  const myReview: MyReview | null = myReviewRow ?? null;
  const myReviewNotice = ownReviewNotice(myReview);

  // BD13 (Q2a): the account's public review name, read only for a reader
  // who may review (own-row read). Null = the form asks for one.
  let myReviewName: string | null = null;
  if (owned && user) {
    const { data: ownProfile } = await supabase
      .from("profiles")
      .select("review_name")
      .eq("id", user.id)
      .maybeSingle<{ review_name: string | null }>();
    myReviewName = ownProfile?.review_name ?? null;
  }

  const seriesInfo: PublicSeries | null = seriesRow ?? null;
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
  // DOWNLOADS-1 (3a, 4a): read only when the panel shows a buyer's
  // Download EPUB.
  const downloadNote =
    purchaseState === "owned"
      ? buyerDownloadNote((await readMyDownloadStates(supabase)).get(book.id))
      : null;
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
  // the full rule -- omitted for "owned" (who already have Download
  // EPUB), shown otherwise (PREVIEW-1: the author too), identically regardless of whether
  // this book's manuscript was uploaded directly as an EPUB or
  // converted from DOCX.
  // PREVIEW-READER-1 (Q6 b, replaces BD16 P4 D6): a pre-order's readers
  // get a sample only once a file has been APPROVED (the sample route
  // reads that same file and never the current one). No approved file
  // yet, or a read error: the button stays hidden. Its author still
  // previews their own.
  let preorderSampleReady = false;
  if (preorder && purchaseState !== "author" && resolveShowSample(purchaseState)) {
    const reviews = await readReviewSnapshots(createAdminClient(), [book.id]);
    preorderSampleReady = reviews.ok && !!latestApprovedReview(reviews.byBook.get(book.id) ?? [])?.file_path;
  }
  const showSample =
    resolveShowSample(purchaseState) && (!preorder || purchaseState === "author" || preorderSampleReady);
  // PREVIEW-READER-1: the sample's end page button, by what the price
  // card offers (the author gets none).
  const sampleEndLink =
    purchaseState === "author"
      ? null
      : {
          targetId: "blerja",
          label: preorder
            ? "Më njofto kur të dalë"
            : purchaseState.includes("free")
              ? "Merreni e-librin"
              : purchaseState.includes("paid") && !purchaseState.includes("closed")
                ? "Blini e-librin"
                : "Kthehuni te libri",
        };

  const authorAvatarUrl = book.pen?.avatar_path
    ? supabase.storage.from("avatars").getPublicUrl(book.pen.avatar_path).data.publicUrl
    : null;
  const penNameLinks = readPenNameLinks(book.pen?.links);
  const penNamePath = book.pen ? authorPagePath(book.pen.id) : null;

  // REDESIGN STEP 3 (P2): the existing purchase sentence, as the price
  // card's footnote. Shown in the same purchase states as before.
  const showPurchaseNote =
    !preorder &&
    (purchaseState === "anonymous-paid" ||
    purchaseState === "anonymous-free" ||
    purchaseState === "anonymous-unavailable" ||
    purchaseState === "paid-unowned" ||
    purchaseState === "free-unowned" ||
    purchaseState === "unavailable-unowned");
  // BD16 P4: a pre-order offers no buy or free form to readers (plan §1
  // "No payment"); the author and an earlier buyer keep their panels.
  const showPreorderPanel = preorder && purchaseState !== "author" && purchaseState !== "owned";
  const checkoutSecurityNote = resolveCheckoutSecurityNote({
    priceAll: book.price_all,
    usePok,
    paidCheckoutAvailable,
  });
  // PEN-NAMES-1 (3a): the byline, "About the author" and "More by ..."
  // all name the book's pen name and link to its page.
  const bookByline = resolveBookByline(book);
  // BD3 patch 4 (1a, 4a): a translated or public-domain book's byline is
  // its "Autori origjinal"; "About the author" and "More by" stay on the
  // pen name the book is published under.
  const authorName = resolveBookPenName(book);
  const originalAuthor = resolveOriginalAuthor(book);
  // 1a (16:05Z): "Përktheu:" names the Translator contributors, else the
  // pen name (linked to its page). Those contributors then leave the
  // contributor line below, so nobody is named twice.
  const translatorNames = originalAuthor
    ? (contributors ?? []).filter((c) => c.role === "Translator").map((c) => c.name.trim()).filter(Boolean)
    : [];
  const otherContributors = originalAuthor
    ? (contributors ?? []).filter((c) => c.role !== "Translator")
    : (contributors ?? []);
  // A "public_domain" book names only typed translators (it can be an
  // untranslated original); an unreadable basis never names the pen name.
  const rightsForByline = rightsForBylinePromise ? await rightsForBylinePromise : null;
  const translatorLine = originalAuthor
    ? resolveTranslatorLine(
        translatorNames,
        authorName,
        rightsForByline?.ok ? rightsForByline.basis : null,
        rightsForByline?.ok === true,
      )
    : null;
  const penIsTranslator = translatorLine !== null && translatorNames.length === 0;
  // TRUST PACK (item 5, 6. a): a plain wa.me link, nothing loaded from WhatsApp.
  const whatsappShareHref = bookWhatsappShareHref(book, bookByline);
  // P2: schema.org Book data for Google, only on a published book (the
  // author's own preview and an earlier buyer's view of an unpublished
  // book carry none, the same rule as generateMetadata's).
  // BD16 P4: a pre-order too, but never with an offer (it can't be bought).
  const jsonLdOrigin = book.status === "published" || preorder ? siteOriginOrNull() : null;
  const bookJsonLd = jsonLdOrigin
    ? serializeJsonLd(
        buildBookJsonLd(book, {
          origin: jsonLdOrigin,
          coverUrl,
          pen: book.pen,
          paidCheckoutOn: paidCheckoutAvailable && !preorder,
          originalAuthor,
          translators: translatorNames,
          penIsTranslator,
        }),
      )
    : null;

  // P1 book page (design B): the price box's "Lexoni një pjesë" and the
  // "Shikoni brenda" pill on the cover open the same sample reader, by
  // the same showSample rule as before.
  const sampleReader = (label: string, triggerClassName: string) => (
    <BookSampleReader
      bookId={book.id}
      bookTitle={book.title}
      label={label}
      triggerClassName={triggerClassName}
      coverUrl={coverUrl}
      endLink={sampleEndLink}
    />
  );
  const boxSample = showSample ? sampleReader("Lexoni një pjesë", SECONDARY_ACTION_CLASSES) : null;
  // P1 (Renato 11-10): pages and reading time come from the same count.
  const pagesText = pageEstimateText(book.word_count);
  const readingTime = readingTimeText(book.word_count);
  const publishedOnLibrum =
    book.status === "published" && book.published_at ? formatTimestampAsDate(book.published_at) : null;

  return (
    // P1 (design B): a white page, on this page only.
    <div className="flex flex-1 flex-col bg-surface">
    <main className="page-container flex-1 pt-4 pb-16 sm:pt-5">
      {bookJsonLd && (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: bookJsonLd }} />
      )}
      {/* PREVIEW-1 (A5, Renato 1a): the author's own unpublished book is
          their "Preview my book" page. Not "only you can see this": a
          reader who bought the book before it was unpublished still can. */}
      {/* BD16 P4: a pre-order is in Librari, so only a draft says this. */}
      {isAuthor && book.status === "draft" && (
        <p
          role="status"
          className="mb-4 rounded-[3px] border-l-4 border-[#806510] bg-[#fbf6e8] px-3 py-2 text-sm font-medium text-foreground"
        >
          Parapamje. Ky libër nuk është në Librari.
        </p>
      )}
      {/* REDESIGN STEP 3 (P1): Bookstore › Genre › Title. */}
      <nav aria-label="Rruga e navigimit" className="text-[0.8125rem] text-muted">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <li>
            <Link href="/librari" className={BREADCRUMB_LINK_CLASSES}>
              Libraria
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

      {/* P1 (design B): the result of what the reader just did (bought,
          got, followed a notice, reported, a held or lapsed checkout, an
          error) sits above the book, where the page opens after the
          redirect. Same texts and the same conditions as before. */}
      {purchase === "success" && (
        <p className={`${NOTICE_CLASSES} bg-green-50 text-green-700`}>
          {owned ? (
            <>
              Blerja u krye. Faleminderit!{" "}
              <Link href="/library" className="focus-ring rounded-sm font-medium underline">
                Shkoni te Biblioteka juaj
              </Link>{" "}
              për ta shkarkuar kurdo.
            </>
          ) : (
            "Blerja u krye. Faleminderit! Mund të duhen disa sekonda që libri të shfaqet më poshtë si i juaji."
          )}
        </p>
      )}
      {freeStatus === "success" && (
        <p className={`${NOTICE_CLASSES} bg-green-50 text-green-700`}>
          {owned ? (
            <>
              U shtua në Bibliotekën tuaj!{" "}
              <Link href="/library" className="focus-ring rounded-sm font-medium underline">
                Shkoni te Biblioteka juaj
              </Link>{" "}
              për ta shkarkuar kurdo.
            </>
          ) : (
            "U shtua në Bibliotekën tuaj! Mund të duhen disa sekonda që libri të shfaqet më poshtë si i juaji."
          )}
        </p>
      )}
      {notifyStatus && (
        <p
          role="status"
          className={`${NOTICE_CLASSES} ${
            notifyStatus === "error" ? "bg-red-50 text-red-700" : "bg-green-50 text-green-700"
          }`}
        >
          {NOTIFY_STATUS_MESSAGES[notifyStatus]}
        </p>
      )}
      {reportStatus === "success" && (
        <p className={`${NOTICE_CLASSES} bg-green-50 text-green-700`}>
          Faleminderit! E morëm raportimin tuaj dhe do ta shqyrtojmë.
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
        <div className={`${NOTICE_CLASSES} bg-amber-50 text-amber-800`}>
          <p className="font-medium">
            Keni tashmë një pagesë të nisur për këtë libër.
          </p>
          <p className="mt-1">
            Shuma e saj e ruajtur është{" "}
            <strong>
              {/* ALL-TXN-CURRENCY-4: a FROZEN checkout amount, in the
                  intent's own frozen currency -- never "any non-ALL
                  currency is dollars". */}
              {formatTransactionAmount(
                heldQuote.price_cents_at_checkout,
                provenanceFromStoredCurrency(heldQuote.currency),
              )}
            </strong>
            . Kjo është shuma që do të paguanit. Çmimi i sotëm dhe kodi
            promocional që sapo vendosët <strong>nuk</strong> zbatohen për
            të.
          </p>
          <p className="mt-1">
            Mund ta përfundoni atë pagesë, ose të prisni t&apos;i kalojë afati
            dhe të nisni një të re me çmimin aktual.
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
              Vazhdoni atë pagesë
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
        <p className={`${NOTICE_CLASSES} bg-amber-50 text-amber-800`}>
          Afati i asaj pagese kaloi para se ta vazhdonit, prandaj nuk u
          tarifua asgjë. Mund të nisni një pagesë të re me çmimin aktual.
        </p>
      )}
      {/* QA-FIX-2: POK sends both a cancel and a failed payment here,
          so the text claims neither a charge nor its absence. Hidden
          once the book is owned (e.g. a later retry succeeded), where
          it would contradict the page. */}
      {canceled === "true" && !owned && (
        <p
          role="status"
          className={`${NOTICE_CLASSES} bg-amber-50 text-amber-800`}
        >
          Pagesa u anulua ose nuk u krye. Mund të provoni përsëri
          kur të jeni gati.
        </p>
      )}
      {error && (
        <p className={`${NOTICE_CLASSES} bg-red-50 text-red-700`}>
          {error}
        </p>
      )}

      {/* ============================================================
          Main Book Hero -- P1 (design B): three columns on a computer
          (cover | title and text | a small price box), two on a tablet
          (the price box under the text), stacked on phones.
          ============================================================ */}
      <div className="mt-5 flex flex-col gap-8 md:grid md:grid-cols-[13rem_minmax(0,1fr)] md:items-start md:gap-x-8 md:gap-y-6 lg:grid-cols-[15rem_minmax(0,1fr)_15.625rem]">
        <div className="mx-auto flex w-56 shrink-0 flex-col items-center gap-2 sm:w-60 md:row-span-2 md:mx-0 md:w-full lg:row-span-1">
          <div className="relative w-full pt-3">
            {coverUrl ? (
              // P1 (design B): the cover opens large (a plain link to the
              // image without JavaScript).
              <CoverZoom src={coverUrl} alt={`Ballina e librit ${book.title}`}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={coverUrl}
                  alt={`Ballina e librit ${book.title}`}
                  fetchPriority="high"
                  className="aspect-[5/8] w-full rounded-[3px] object-contain object-bottom drop-shadow-[0_2px_8px_rgba(0,0,0,0.18)]"
                />
              </CoverZoom>
            ) : (
              <CoverPlaceholder
                title={book.title}
                authorName={bookByline}
                className="aspect-[5/8] w-full rounded-[3px] shadow-[0_2px_8px_rgba(0,0,0,0.18)]"
              />
            )}
            {/* See resolveShowSample's own comment (src/lib/book-purchase.ts):
                omitted for "owned", who already have Download EPUB. */}
            {showSample && (
              <div className="absolute top-0 left-1/2 z-10 -translate-x-1/2">
                {sampleReader("Shikoni brenda", COVER_PILL_CLASSES)}
              </div>
            )}
          </div>
          {coverUrl && <p className="text-xs text-muted">Klikoni ballinën për ta parë të madhe</p>}
        </div>

        <div className="min-w-0">
          <h1 className="font-serif text-[1.75rem] leading-[1.2] font-normal text-foreground sm:text-[1.875rem]">
            {book.title}
          </h1>
          {/* LIBRUM 2.0 PUBLISHING-UX-1 PART D: rendered as its own,
              visually secondary element -- never joined into the h1's
              own text -- so a screen reader's page-title/heading
              structure stays exactly "book.title". Omitted entirely
              when null. */}
          {book.subtitle && (
            <p className="mt-1 font-serif text-lg text-muted italic">{book.subtitle}</p>
          )}
          {/* BD16 P4 (D1, D7): "Del më 12 dhjetor 2026". */}
          {releaseLabel && (
            <p data-preorder-release="" className="mt-2">
              <span className={PREORDER_BADGE_CLASSES}>{releaseLabel}</span>
            </p>
          )}

          {/* P1 (design B): "nga <name> (Autor)". BD3 patch 4: with an
              "Autori origjinal" that is the name, now a link to the
              Libraria search for it (search matches original_author);
              the translator follows as "(Përkthyes)". */}
          {(originalAuthor || bookByline) && (
            <p className="mt-2 text-[0.9375rem] text-foreground">
              nga{" "}
              {originalAuthor ? (
                <Link href={buildBookstoreHref({}, { q: originalAuthor })} className={INLINE_LINK_CLASSES}>
                  {originalAuthor}
                </Link>
              ) : penNamePath ? (
                <Link href={penNamePath} className={INLINE_LINK_CLASSES}>
                  {bookByline}
                </Link>
              ) : (
                <span className="font-semibold">{bookByline}</span>
              )}{" "}
              <span className="text-muted">(Autor)</span>
              {/* 1a (16:05Z): the Translator contributors, else the pen
                  name (linked to its page). */}
              {originalAuthor && translatorLine && (
                <>
                  {" · "}
                  {!penIsTranslator ? (
                    <span className="font-semibold">{translatorLine}</span>
                  ) : penNamePath ? (
                    <Link href={penNamePath} className={INLINE_LINK_CLASSES}>
                      {authorName}
                    </Link>
                  ) : (
                    <span className="font-semibold">{authorName}</span>
                  )}{" "}
                  <span className="text-muted">{TRANSLATOR_ROLE}</span>
                </>
              )}
            </p>
          )}

          {/* BD15 P7 (Q4 a): the uploader of a public-domain edition, only
              when Librum gave the editor mention (otherwise no pen name
              reaches this page at all). */}
          {showsPreparedBy(book) && authorName && (
            <p className="mt-1 text-[0.9375rem] text-foreground">
              {PD_PREPARED_BY}{" "}
              {penNamePath ? (
                <Link href={penNamePath} className={INLINE_LINK_CLASSES}>
                  {authorName}
                </Link>
              ) : (
                <span className="font-semibold">{authorName}</span>
              )}
            </p>
          )}

          {otherContributors.length > 0 && (
            <p className="mt-1 text-sm text-muted">
              {otherContributors
                .map(
                  (c) =>
                    `${CONTRIBUTOR_ROLE_VERB[c.role as keyof typeof CONTRIBUTOR_ROLE_VERB] ?? c.role} ${c.name}`,
                )
                .join(" · ")}
            </p>
          )}

          {/* Upload notes C: the book's type, then the genre; P1: plain
              words, no capitals. (Upload notes 3a: no "ebook" word here.) */}
          {bookEyebrow(book) && (
            <p className="mt-1 text-[0.8125rem] text-muted">{bookEyebrow(book)}</p>
          )}

          {seriesInfo && (
            <p className="mt-1 text-sm text-foreground">
              {book.series_position ? `Libri ${book.series_position} i serisë ` : "Pjesë e serisë "}
              <Link href={`/seri/${seriesInfo.id}`} className={INLINE_LINK_CLASSES}>
                {seriesInfo.title}
              </Link>
            </p>
          )}

          <div className="mt-2 flex items-center gap-2.5 text-sm">
            {/* FIX1 (X4): no star row (and no "0 out of 5 stars" for
                screen readers) until the first review; the words stay. */}
            {reviewCount > 0 && <StarRating rating={averageRating} />}
            <span className="text-muted">
              {reviewCount > 0
                ? `${averageRating.toFixed(1).replace(".", ",")} · ${reviewCount} ${reviewCount === 1 ? "vlerësim" : "vlerësime"}`
                : "Ende pa vlerësime"}
            </span>
          </div>

          <hr className="my-4 border-0 border-t border-border" />

          {/* LIBRUM 2.0 PRODUCT-1: only the real description. BD15 P8:
              the rich description (bold, italic, lists), parsed -- never
              rendered as HTML. P1 (design B): serif, folded after four
              lines with "Lexo më shumë" (the whole text without
              JavaScript). */}
          {book.description && (
            <section aria-labelledby="rreth-librit">
              <h2 id="rreth-librit" className="sr-only">Rreth librit</h2>
              <ExpandableText lines={4} className="max-w-[42.5rem] font-serif text-base leading-[1.6] text-foreground/90">
                <BookDescriptionView stored={book.description} />
              </ExpandableText>
            </section>
          )}

          {/* ============================================================
              Book Details -- P1 (design B): a row of tiles for the five
              quick facts, then the rest as plain "Label: value" lines
              (no capital-letter labels). As before, every row but
              Formati renders only when the book carries a real value;
              nothing is guessed, defaulted or substituted (Publisher
              never falls back to "Librum" or the author's own name).
              ============================================================ */}
          <section aria-labelledby="te-dhenat" className="mt-5">
            <h2 id="te-dhenat" className="sr-only">Të dhënat e librit</h2>
            <dl data-detail-tiles="" className="grid grid-cols-[repeat(auto-fit,minmax(4.25rem,1fr))] overflow-hidden rounded-[8px] border border-border [&>div]:-mr-px [&>div]:border-r [&>div]:border-border">
              {/* Upload notes D: words / 250, only once the file is counted. */}
              {pagesText && (
                <DetailTile label={PAGE_ESTIMATE_LABEL} icon={<IconPage className={TILE_ICON_CLASSES} />}>
                  {pagesText}
                </DetailTile>
              )}
              {/* Renato 11-10 (a): minutes under an hour, else hours. */}
              {readingTime && (
                <DetailTile label={READING_TIME_LABEL} icon={<IconClock className={TILE_ICON_CLASSES} />}>
                  {readingTime}
                </DetailTile>
              )}
              {book.language && (
                <DetailTile label="Gjuha" icon={<IconGlobe className={TILE_ICON_CLASSES} />}>
                  {getLanguageLabel(book.language)}
                </DetailTile>
              )}
              {/* LIBRUM 2.0 PUBLISHING-UX-1 PART D: published_at only --
                  never created_at/updated_at. Requires BOTH a published
                  book AND a real published_at (a legacy book published
                  before migration 044 has none, and gets no tile). */}
              {publishedOnLibrum && (
                <DetailTile label="Botuar" icon={<IconCalendar className={TILE_ICON_CLASSES} />}>
                  {publishedOnLibrum}
                </DetailTile>
              )}
              <DetailTile label="Formati" icon={<IconDevice className={TILE_ICON_CLASSES} />}>
                <Acronym>EPUB</Acronym>
              </DetailTile>
            </dl>

            <dl data-detail-rows="" className="mt-4 flex flex-col gap-1 text-[0.9375rem] leading-relaxed">
              {/* Upload notes C: the book's type, before its genres. */}
              {bookTypeOf(book) && (
                <DetailRow label={BOOK_TYPE_LABEL}>{bookTypeOf(book)}</DetailRow>
              )}
              {/* BD15 P8 (Q3 a): every category, each a link to that
                  category in Libraria; then 18+ or the reading age. */}
              {bookCategories(book).length > 0 && (
                <DetailRow label={categoriesLabel(bookCategories(book).length)}>
                  {bookCategories(book).map((category, index) => (
                    <Fragment key={category}>
                      {index > 0 && ", "}
                      <Link
                        href={buildBookstoreHref({}, { genre: category })}
                        className={INLINE_LINK_CLASSES}
                      >
                        {category}
                      </Link>
                    </Fragment>
                  ))}
                </DetailRow>
              )}
              {book.is_adult && (
                <DetailRow label={ADULT_DETAIL_LABEL}>{ADULT_DETAIL_VALUE}</DetailRow>
              )}
              {readingAgeValue(book) && (
                <DetailRow label={READING_AGE_LABEL}>{readingAgeValue(book)}</DetailRow>
              )}
              {seriesInfo && (
                <DetailRow label="Seria">
                  {book.series_position ? `Libri ${book.series_position} i serisë ` : ""}
                  <Link href={`/seri/${seriesInfo.id}`} className={INLINE_LINK_CLASSES}>
                    {seriesInfo.title}
                  </Link>
                </DetailRow>
              )}
              {book.publisher && (
                <DetailRow label="Botuesi">{book.publisher}</DetailRow>
              )}
              {/* BD15 P8: the edition number, else the old free text. */}
              {editionValue(book) && (
                <DetailRow label={EDITION_LABEL}>{editionValue(book)}</DetailRow>
              )}
              {book.original_publication_date && (
                <DetailRow label="Botuar për herë të parë">
                  {formatDateOnly(book.original_publication_date)}
                </DetailRow>
              )}
              {releaseLabel && (
                <DetailRow label="Parapublikim">{releaseLabel}</DetailRow>
              )}
              {book.isbn && (
                <DetailRow label="ISBN">{book.isbn}</DetailRow>
              )}
            </dl>
          </section>
        </div>

        {/* REDESIGN STEP 3 (P2) -> P1 (design B): the purchase panel as a
            small box -- the price, the main action as a gold pill, the
            sample as an outline pill, save for later, then sharing.
            Which controls show, and every form and action, are exactly
            as before. */}
        {/* PREVIEW-READER-1: id="blerja" is where the sample's end page
            button takes the reader. */}
        <aside aria-label="Çmimi dhe marrja e librit" className="w-full md:col-start-2 lg:col-start-3 lg:row-start-1">
          <div id="blerja" className="flex scroll-mt-24 flex-col gap-3 rounded-[8px] border border-[#d9d3c3] p-4">
            <span className="text-2xl font-semibold text-foreground">{formattedPrice}</span>

            {showPreorderPanel ? (
              <PreorderPanel
                bookId={book.id}
                signedIn={!!user}
                notifyOn={notifyOn}
                sampleSlot={boxSample}
              />
            ) : (
              <PurchasePanel
                state={purchaseState}
                bookId={book.id}
                formattedPrice={formattedPrice}
                wishlisted={wishlisted}
                downloadNote={downloadNote}
                sampleSlot={boxSample}
              />
            )}
            {preorder && <p className={BOX_NOTE_CLASSES}>{PREORDER_PRICE_NOTE}</p>}

            {showPurchaseNote &&
              (purchaseState === "anonymous-unavailable" ||
              purchaseState === "unavailable-unowned" ? (
                // ALL-WIRING-2: three-way, same classification the
                // purchase state above used. The unavailable copy makes
                // no promise about acquiring the book, because there is
                // no acquisition form on the page in that state.
                <p className={BOX_NOTE_CLASSES}>
                  Ky libër nuk ka ende çmim, prandaj nuk mund të blihet ose të shkarkohet tani.
                </p>
              ) : book.price_all === 0 ? (
                <p className={BOX_NOTE_CLASSES}>
                  Falas, pa pagesë. Do të merrni një <Acronym>EPUB</Acronym> pa <Acronym>DRM</Acronym> që mund ta shkarkoni kurdo nga Biblioteka juaj në Librum.
                  {checkoutSecurityNote}
                </p>
              ) : (
                // REDESIGN STEP 3 (Renato D4): the mockup's three lines
                // for a paid book. The third line said "or with the POK
                // app" until Renato's C1 answer (b): it comes back only once
                // paying with the POK app is proven in our checkout.
                <ul className={`flex flex-col gap-1 ${BOX_NOTE_CLASSES}`}>
                  <li><Acronym>EPUB</Acronym>, pa <Acronym>DRM</Acronym>. Lexojeni në telefon, tablet ose lexues elektronik.</li>
                  <li>Shkarkojeni kurdo nga Biblioteka juaj në Librum.</li>
                  <li>Paguani me kartë.</li>
                  {checkoutSecurityNote && <li>{checkoutSecurityNote.trim()}</li>}
                </ul>
              ))}

            {purchaseState === "owned" && book.status === "draft" && (
              <p className="text-[0.8125rem] font-medium text-amber-700">
                Ky libër nuk shitet më. Kopjen tuaj mund ta shkarkoni
                përsëri kurdo.
              </p>
            )}

            {/* TRUST PACK (item 5, 6. a): a plain wa.me link, nothing loaded
                from WhatsApp. P1: plus "Kopjo lidhjen" (this page's own
                address, copied in the browser). */}
            {whatsappShareHref && (
              <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-1 border-t border-border pt-3 text-xs">
                <span className="text-muted">Ndajeni:</span>
                <a
                  href={whatsappShareHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="Ndajeni në WhatsApp"
                  className={SHARE_LINK_CLASSES}
                >
                  WhatsApp
                </a>
                <span aria-hidden="true" className="text-muted">·</span>
                <CopyLinkButton path={bookPagePath(book.id)} className={SHARE_LINK_CLASSES} />
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* ============================================================
          About the Author -- P1 (design B): no big card. The photo,
          name, how many of its books are in Librum, Follow, the
          author's own links as icons, the bio (folded), and "More by"
          under it.
          ============================================================ */}
      {/* BD15 P7: not on a public-domain edition without the editor
          mention -- the page has no pen name for it. */}
      {book.pen && (
      <section className={PAGE_SECTION_CLASSES}>
        <h2 className={SECTION_HEADING}>Rreth autorit</h2>
        <div className="mt-4 flex flex-col gap-6 sm:flex-row sm:items-start sm:gap-8">
          <div className="flex shrink-0 flex-col items-center gap-2 text-center sm:w-48">
            {authorAvatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={authorAvatarUrl}
                alt=""
                className="size-24 shrink-0 rounded-full object-cover"
              />
            ) : (
              // iPhone step (I4): the author's initials, as on the author's
              // own page, instead of an empty circle. aria-hidden: the name
              // is the very next element.
              <div
                aria-hidden="true"
                className="flex size-24 shrink-0 items-center justify-center rounded-full bg-[#d9e2dc] text-2xl font-semibold text-foreground/70"
              >
                {getAuthorInitials(authorName ?? "")}
              </div>
            )}
            {penNamePath ? (
              <Link href={penNamePath} className="focus-ring rounded-sm text-base font-semibold text-primary hover:underline">
                {authorName}
              </Link>
            ) : (
              <p className="text-base font-semibold text-foreground">{authorName}</p>
            )}
            {/* P1: only the books readers can already find under this pen
                name (the same listed, priced rows as "More by"). */}
            {typeof penBookCount === "number" && penBookCount > 0 && (
              <p className="text-[0.8125rem] text-muted">
                {penBookCount} {penBookCount === 1 ? "libër" : "libra"} në Librum
              </p>
            )}
            {!isAuthor &&
              penNamePath &&
              (user ? (
                <form
                  action={(isFollowingAuthor ? unfollowAuthorFromBook : followAuthorFromBook).bind(
                    null,
                    book.pen_name_id!,
                    book.id,
                  )}
                >
                  <button
                    type="submit"
                    className={isFollowingAuthor ? FOLLOWING_PILL_CLASSES : FOLLOW_PILL_CLASSES}
                  >
                    {isFollowingAuthor ? "Po e ndiqni" : "Ndiqni"}
                  </button>
                </form>
              ) : (
                // The author page's own "Log in to follow" link, unchanged:
                // after logging in the reader follows from that page.
                <Link href={`/login?next=${penNamePath}`} className={FOLLOWING_PILL_CLASSES}>
                  Hyr për ta ndjekur
                </Link>
              ))}
            {penNameLinks.length > 0 && (
              <ul className="mt-1 flex flex-wrap justify-center gap-1">
                {penNameLinks.map((link) => (
                  <li key={link}>
                    <a
                      href={link}
                      rel="nofollow ugc noopener noreferrer"
                      target="_blank"
                      aria-label={penNameLinkName(link)}
                      title={penNameLinkLabel(link)}
                      className="focus-ring flex size-10 items-center justify-center rounded-full text-primary hover:bg-surface-hover"
                    >
                      <PenNameLinkIcon link={link} />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="min-w-0 flex-1">
            {book.pen?.bio && (
              <ExpandableText lines={3} className="max-w-[42.5rem] text-[0.9375rem] leading-relaxed text-foreground/90">
                <p className="whitespace-pre-line">{book.pen.bio}</p>
              </ExpandableText>
            )}
            {penNamePath && (
              <Link
                href={penNamePath}
                className="focus-ring mt-2 inline-block rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
              >
                Shikoni profilin e autorit &rsaquo;
              </Link>
            )}
            {/* 3a: "More by" = only books under this book's pen name. */}
            <BookShelf
              inline
              title={authorName ? `Më shumë nga ${authorName}` : "Më shumë nga ky autor"}
              books={moreByAuthor ?? []}
              supabase={supabase}
            />
          </div>
        </div>
      </section>
      )}

      {/* ============================================================
          Reviews
          ============================================================ */}
      {/* BD13: id="vleresimet" is where the end page's review link
          (BD4b) and the after-save redirect land. */}
      <section id="vleresimet" className={`${PAGE_SECTION_CLASSES} scroll-mt-24`}>
        <h2 className={SECTION_HEADING}>Vlerësimet</h2>

        {(reviewStatus === "pending" || reviewStatus === "unchanged") && (
          <p
            role="status"
            className="mt-4 max-w-[42.5rem] rounded-[3px] bg-green-50 px-3 py-2 text-sm text-green-700"
          >
            {reviewStatus === "pending" ? REVIEW_PENDING_NOTICE : REVIEW_UNCHANGED_NOTICE}
          </p>
        )}

        {owned && (
          <form
            action={submitReview.bind(null, book.id)}
            className="mt-4 flex max-w-[42.5rem] flex-col gap-3 rounded-[8px] border border-border p-5"
          >
            <p className="text-sm font-medium">
              {myReview ? "Përditësoni vlerësimin tuaj" : "Lini një vlerësim"}
            </p>
            {myReviewNotice && (
              <div
                className={`rounded-[3px] px-3 py-2 text-sm ${
                  myReviewNotice.tone === "warning" ? "bg-amber-50 text-amber-800" : "bg-blue-50 text-blue-800"
                }`}
              >
                {myReviewNotice.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
              </div>
            )}
            {myReviewName ? (
              <p className="text-sm text-muted">
                Shfaqeni si: <span className="font-medium text-foreground">{myReviewName}</span>
              </p>
            ) : (
              <label className="flex flex-col gap-1 text-sm">
                Emri që shfaqet
                <input
                  type="text"
                  name="review_name"
                  required
                  minLength={2}
                  maxLength={REVIEW_NAME_MAX}
                  autoComplete="nickname"
                  className="focus-ring rounded-[3px] border border-[#8c8472] bg-surface px-3 py-2"
                />
                <span className="text-xs text-muted">{REVIEW_NAME_HELP}</span>
              </label>
            )}
            <label className="flex flex-col gap-1 text-sm">
              Yjet
              <select
                name="rating"
                required
                defaultValue={myReview?.rating ?? ""}
                className="focus-ring rounded-[3px] border border-[#8c8472] bg-surface px-3 py-2"
              >
                <option value="" disabled>
                  Zgjidhni yjet
                </option>
                <option value="5">★★★★★</option>
                <option value="4">★★★★☆</option>
                <option value="3">★★★☆☆</option>
                <option value="2">★★☆☆☆</option>
                <option value="1">★☆☆☆☆</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Komenti (opsional)
              <textarea
                name="body"
                rows={3}
                maxLength={REVIEW_BODY_MAX}
                defaultValue={myReview?.body ?? ""}
                className="focus-ring rounded-[3px] border border-[#8c8472] bg-surface px-3 py-2"
              />
            </label>
            {myReview?.status === "approved" && (
              <p className="text-xs text-muted">{REVIEW_EDIT_WARNING}</p>
            )}
            <button
              type="submit"
              className={buttonClasses("primary", "md", "w-fit rounded-[3px]")}
            >
              {myReview ? "Përditësoni vlerësimin" : "Dërgoni vlerësimin"}
            </button>
            <p className="text-xs text-muted">{REVIEW_RULES_NOTE}</p>
          </form>
        )}

        {allReviews.length === 0 ? (
          <p className="mt-4 text-muted">Ende nuk ka vlerësime.</p>
        ) : (
          <ul className="mt-6 flex max-w-[42.5rem] flex-col gap-4">
            {allReviews.map((review) => (
              <li key={review.id} className="border-t border-border pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <StarRating rating={review.rating} />
                  <span className="text-sm font-medium">
                    {review.reviewer_name ?? ANONYMOUS_REVIEWER_NAME}
                  </span>
                  {review.verified && (
                    <span className="rounded-[3px] bg-green-50 px-1.5 py-0.5 text-xs font-medium text-green-800">
                      {VERIFIED_PURCHASE_LABEL}
                    </span>
                  )}
                  {review.reviewer_is_author && (
                    <span className="rounded-[3px] border border-border px-1.5 py-0.5 text-xs font-medium text-muted">
                      {AUTHOR_REVIEWER_LABEL}
                    </span>
                  )}
                  {/* REVIEW-DATE: the day the reader first wrote it
                      (created_at, already in public_reviews), in Tirana,
                      same Albanian format as "Botuar në Librum". An edit
                      keeps this date. */}
                  <time
                    dateTime={review.created_at}
                    className="text-xs text-muted"
                  >
                    {formatTimestampAsDate(review.created_at)}
                  </time>
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
          "View series ->" (the one clear link to the new /seri/[id]
          page from this section) and a Previous/Next continuity block,
          both derived from the exact same seriesEntries/orderSeriesBooks
          order this list itself already renders in -- never a second,
          differently-ordered query.
          ============================================================ */}
      {seriesInfo && seriesEntries.length > 1 && (
        <section className={`${PAGE_SECTION_CLASSES} max-w-[42.5rem]`}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className={SECTION_HEADING}>{seriesInfo.title}</h2>
            <Link
              href={`/seri/${seriesInfo.id}`}
              className="focus-ring shrink-0 rounded-sm text-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
            >
              Shikoni serinë &rarr;
            </Link>
          </div>

          {/* Previous/Next -- published-only (seriesEntries is already
              published-only), never wraps last -> first or first ->
              last. Absent entirely for a single-book series (this whole
              section already requires seriesEntries.length > 1) and
              renders nothing on whichever side has no neighbor. */}
          {(previousInSeries || nextInSeries) && (
            <div className="mt-4 flex flex-col gap-3 rounded-[8px] border border-border p-4 sm:flex-row sm:items-start sm:justify-between">
              {previousInSeries ? (
                <Link
                  href={`/libra/${previousInSeries.id}`}
                  className="focus-ring group flex flex-col rounded-sm"
                >
                  <span className="text-xs text-muted">&larr; I mëparshmi në seri</span>
                  <span className="font-serif text-lg text-primary underline underline-offset-2 group-hover:decoration-2">
                    {previousInSeries.series_position != null
                      ? `Libri ${previousInSeries.series_position} — `
                      : ""}
                    {previousInSeries.title}
                  </span>
                </Link>
              ) : (
                <span />
              )}
              {nextInSeries ? (
                <Link
                  href={`/libra/${nextInSeries.id}`}
                  className="focus-ring group flex flex-col rounded-sm sm:items-end sm:text-right"
                >
                  <span className="text-xs text-muted">I radhës në seri &rarr;</span>
                  <span className="font-serif text-lg text-primary underline underline-offset-2 group-hover:decoration-2">
                    {nextInSeries.series_position != null
                      ? `Libri ${nextInSeries.series_position} — `
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
                    <span className="text-xs text-muted">(ky libër)</span>
                  </span>
                ) : (
                  <Link href={`/libra/${entry.id}`} className={INLINE_LINK_CLASSES}>
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
        headingClassName={SECTION_HEADING}
        title="Mund t'ju pëlqejnë edhe"
        books={youMightLike}
        supabase={supabase}
      />

      {/* ============================================================
          Report this book
          ============================================================ */}
      {user && !isAuthor && (
        <p className="mt-10 text-xs text-muted">
          <Link
            href={`/libra/${book.id}/report`}
            className="focus-ring rounded-sm underline underline-offset-2 hover:decoration-2"
          >
            Raportoni këtë libër
          </Link>
        </p>
      )}
    </main>
    </div>
  );
}

// REDESIGN STEP 3 -> P1 (design B, 2026-11-10): shared classes for this
// page. Plain section headings with a thin rule above each section; links
// inside sentences underlined at rest (C1).
const SECTION_HEADING = "text-xl font-semibold text-foreground";
const PAGE_SECTION_CLASSES = "mt-12 border-t border-border pt-6";
const INLINE_LINK_CLASSES =
  "focus-ring rounded-sm font-semibold text-primary underline underline-offset-2 hover:decoration-2";
const BREADCRUMB_LINK_CLASSES =
  "focus-ring rounded-sm underline underline-offset-2 hover:text-primary hover:decoration-2";
const NOTICE_CLASSES = "mt-4 max-w-[32.5rem] rounded-[8px] px-3 py-2 text-sm";
const BOX_NOTE_CLASSES = "text-[0.8125rem] text-muted";
const SHARE_LINK_CLASSES =
  "focus-ring rounded-sm font-medium text-primary underline underline-offset-2 hover:decoration-2";
const TILE_ICON_CLASSES = "size-[1.375rem]";
// BD3 patch 4 -> P1: the role after the translator's name.
const TRANSLATOR_ROLE = "(Përkthyes)";

// P1 (Renato 12:47): "EPUB" and "DRM" stay capitals, a little smaller.
function Acronym({ children }: { children: string }) {
  return <span className="text-[0.82em] tracking-[0.03em]">{children}</span>;
}

// P1 (design B): one quick-fact tile -- label, picture, value.
function DetailTile({ label, icon, children }: { label: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center px-1.5 py-3 text-center">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="flex flex-col items-center">
        <span aria-hidden="true" className="my-1.5 text-primary">
          {icon}
        </span>
        <span className="text-sm font-semibold text-foreground">{children}</span>
      </dd>
    </div>
  );
}

// P1 (design B): one plain "Label: value" line (no capital-letter label).
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="inline text-muted">{label}:</dt>{" "}
      <dd className="inline text-foreground">{children}</dd>
    </div>
  );
}

// P1 (design B): the author's own links as icons (Instagram, Facebook,
// else a globe), named for screen readers.
function penNameLinkName(link: string): string {
  const kind = penNameLinkKind(link);
  if (kind === "instagram") return `Instagram: ${penNameLinkLabel(link)}`;
  if (kind === "facebook") return `Facebook: ${penNameLinkLabel(link)}`;
  return penNameLinkLabel(link);
}

function PenNameLinkIcon({ link }: { link: string }) {
  const kind = penNameLinkKind(link);
  const className = "size-5";
  return (
    <span aria-hidden="true">
      {kind === "instagram" ? (
        <IconInstagram className={className} />
      ) : kind === "facebook" ? (
        <IconFacebook className={className} />
      ) : (
        <IconGlobe className={className} />
      )}
    </span>
  );
}

// REDESIGN STEP 3 (B5): the author page's own follow/unfollow actions,
// unchanged, plus a refresh of this book page so the button shows the
// new state at once (those actions only refresh the author's page).
// Only rendered for a signed-in reader who is not the author.
// PEN-NAMES-1: the id is the book's pen name id.
async function followAuthorFromBook(penNameId: string, bookId: string) {
  "use server";
  await followPenName(penNameId);
  revalidatePath(`/libra/${bookId}`);
}

async function unfollowAuthorFromBook(penNameId: string, bookId: string) {
  "use server";
  await unfollowPenName(penNameId);
  revalidatePath(`/libra/${bookId}`);
}

// PAID-CHECKOUT-SURFACE-1: the one reader-facing sentence for a paid book
// while paid checkout is closed. Deliberately says nothing about why.
const PAID_CHECKOUT_UNAVAILABLE_NOTICE = "Ky libër nuk mund të blihet ende.";

// REDESIGN STEP 3 (P2) -> P1 (design B): full-width pills inside the
// price box -- the main one gold, the secondary one outlined under it,
// save for later as a quiet text button.
const PRIMARY_ACTION_CLASSES =
  "focus-ring inline-flex w-full items-center justify-center rounded-full bg-accent px-3 py-2.5 text-center text-sm font-semibold text-accent-foreground transition-colors hover:bg-[#c9a42c] disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_ACTION_CLASSES =
  "focus-ring inline-flex w-full items-center justify-center rounded-full border border-primary bg-surface px-3 py-2 text-center text-sm font-semibold text-primary transition-colors hover:bg-surface-hover";
const WISHLIST_ACTION_CLASSES =
  "focus-ring w-full rounded-sm py-1 text-center text-[0.8125rem] font-medium text-primary underline underline-offset-2 hover:decoration-2";
const COVER_PILL_CLASSES =
  "focus-ring inline-flex items-center whitespace-nowrap rounded-full border border-[#d9d3c3] bg-surface px-3 py-1 text-xs font-semibold text-primary shadow-sm hover:bg-surface-hover";
const FOLLOW_PILL_CLASSES =
  "focus-ring inline-flex items-center justify-center rounded-full bg-accent px-5 py-1.5 text-sm font-semibold text-accent-foreground transition-colors hover:bg-[#c9a42c]";
const FOLLOWING_PILL_CLASSES =
  "focus-ring inline-flex items-center justify-center rounded-full border border-primary px-4 py-1.5 text-sm font-semibold text-primary transition-colors hover:bg-surface-hover";
const STATUS_PILL_CLASSES = "rounded-[8px] bg-surface-hover px-3 py-2.5 text-center text-sm font-medium";
const PREORDER_BADGE_CLASSES =
  "inline-block rounded-[3px] border border-[#806510] bg-[#fbf6e8] px-2.5 py-1 text-sm font-semibold text-[#5c480b]";

// BD16 P4 ("Më njofto", plan §1 and D8): a pre-order's panel for readers.
// No buy, free or wishlist form; a signed-out visitor is asked to sign in
// and comes back to this page.
function PreorderPanel({
  bookId,
  signedIn,
  notifyOn,
  sampleSlot,
}: {
  bookId: string;
  signedIn: boolean;
  notifyOn: boolean;
  // P1: the sample button, right after the main action.
  sampleSlot: React.ReactNode;
}) {
  if (!signedIn) {
    return (
      <div className="flex flex-col gap-3">
        <Link href={`/login?next=/libra/${bookId}`} className={PRIMARY_ACTION_CLASSES}>
          {NOTIFY_SIGN_IN_LABEL}
        </Link>
        {sampleSlot}
        <p className="text-xs text-muted">{NOTIFY_HELP}</p>
      </div>
    );
  }
  if (notifyOn) {
    return (
      <div className="flex flex-col gap-3">
        <span className={STATUS_PILL_CLASSES}>{NOTIFY_ON_NOTICE}</span>
        <form action={removePreorderNotice.bind(null, bookId, "book")}>
          <button type="submit" className={SECONDARY_ACTION_CLASSES}>
            {NOTIFY_REMOVE_LABEL}
          </button>
        </form>
        {sampleSlot}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <form action={notifyMeWhenOut.bind(null, bookId)}>
        <button type="submit" className={PRIMARY_ACTION_CLASSES}>
          {NOTIFY_ME_LABEL}
        </button>
      </form>
      {sampleSlot}
      <p className="text-xs text-muted">{NOTIFY_HELP}</p>
    </div>
  );
}

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
  downloadNote,
  sampleSlot,
}: {
  state: BookPurchaseState;
  bookId: string;
  formattedPrice: string;
  wishlisted: boolean;
  // DOWNLOADS-1: the buyer's line under Download EPUB ("owned" only).
  downloadNote: string | null;
  // P1 (design B): the sample button, after the main action and before
  // save for later (null where the sample is not shown, as before).
  sampleSlot: React.ReactNode;
}) {
  const wishlistForm = (
    <form action={(wishlisted ? removeFromWishlist : addToWishlist).bind(null, bookId)}>
      <button type="submit" className={WISHLIST_ACTION_CLASSES}>
        {wishlisted ? "Hiqeni nga Lista e dëshirave" : "Ruajeni për më vonë"}
      </button>
    </form>
  );

  if (state === "author") {
    return (
      <div className="flex flex-col gap-3">
        <span className="text-sm text-muted">Ky është libri juaj</span>
        <Link href={editorPath(bookId, "details")} className={PRIMARY_ACTION_CLASSES}>
          Menaxhoni librin
        </Link>
        <a href={`/api/books/${bookId}/download`} className={SECONDARY_ACTION_CLASSES}>
          Shkarkoni <Acronym>EPUB</Acronym>
        </a>
        {sampleSlot}
      </div>
    );
  }

  if (state === "owned") {
    return (
      <div className="flex flex-col gap-3">
        <span className={STATUS_PILL_CLASSES}>Ky libër është i juaji</span>
        <a href={`/api/books/${bookId}/download`} className={PRIMARY_ACTION_CLASSES}>
          Shkarkoni <Acronym>EPUB</Acronym>
        </a>
        {downloadNote && <p className="text-xs text-muted">{downloadNote}</p>}
        {/* D13 2a / BD4: the sharing reminder next to Download. */}
        <p className="text-xs text-muted">{SHARING_REMINDER}</p>
        {/* TRUST PACK (item 5, 1. a): the reader help page, next to Download. */}
        <Link href="/ndihme/leximi" className="w-fit text-xs text-muted underline underline-offset-2 hover:text-foreground">
          Si ta lexoni librin
        </Link>
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
        <span className={`${STATUS_PILL_CLASSES} text-muted`}>Nuk mund të blihet tani</span>
        {sampleSlot}
      </div>
    );
  }

  if (state === "unavailable-unowned") {
    return (
      <div className="flex flex-col gap-3">
        <span className={`${STATUS_PILL_CLASSES} text-muted`}>Nuk mund të blihet tani</span>
        {sampleSlot}
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
        {sampleSlot}

        {state === "paid-unowned-checkout-closed" && wishlistForm}
      </div>
    );
  }

  if (state === "anonymous-paid" || state === "anonymous-free") {
    return (
      <div className="flex flex-col gap-3">
        <Link href={`/login?next=/libra/${bookId}`} className={PRIMARY_ACTION_CLASSES}>
          {state === "anonymous-free" ? "Hyr për ta marrë këtë libër" : "Hyr për ta blerë"}
        </Link>
        {sampleSlot}
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
            Merreni e-librin — Falas
          </button>
        </form>
      ) : (
        <form action={buyBook.bind(null, bookId)} className="flex flex-col gap-3">
          <input
            name="code"
            type="text"
            aria-label="Kodi promocional (opsional)"
            placeholder="Kodi promocional (opsional)"
            className="focus-ring w-full rounded-[8px] border border-[#8c8472] bg-surface px-3 py-2 text-sm"
          />
          <button type="submit" className={PRIMARY_ACTION_CLASSES}>
            Blini e-librin — {formattedPrice}
          </button>
        </form>
      )}

      {sampleSlot}
      {wishlistForm}
    </div>
  );
}
