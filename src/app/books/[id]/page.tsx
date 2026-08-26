import Link from "next/link";
import { notFound } from "next/navigation";
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
import { CONTRIBUTOR_ROLE_VERB } from "@/lib/contributor-roles";
import { formatPrice } from "@/lib/pricing";
import { resolveBookPurchaseState, type BookPurchaseState } from "@/lib/book-purchase";
import { buttonClasses } from "@/components/ui/button";
import type { Book, Profile, Review, Series, Contributor } from "@/lib/types";

// LIBRUM 2.0 UI-5: this page is the reader DECISION + PURCHASE surface
// -- Bookstore (UI-4) owns discovery/browsing, this page owns "should I
// buy this book." Presentation-only pass: every query below, and every
// server action bound into a form, is unchanged from before this pass
// -- see actions.ts/checkout-logic.ts, neither of which this pass
// touches. Query sequencing is also left exactly as it was (a
// PERF-1 follow-up to parallelize the independent fetches is tracked
// separately, deliberately not bundled into this visual pass).

// The book's own author/profile join needs `bio` (for the new "About
// the Author" section) on top of the `display_name` every other
// book-with-author query on this page already selects -- kept as its
// own type, distinct from BookWithAuthor below, so the shelf queries
// (which only ever need display_name) aren't forced to also carry a
// bio field they never fetch.
type BookWithAuthorBio = Book & { profiles: Pick<Profile, "display_name" | "bio"> | null };
type BookWithAuthor = Book & { profiles: Pick<Profile, "display_name"> | null };
type SeriesEntry = Pick<Book, "id" | "title" | "series_position">;
type ReviewWithReader = Review & {
  profiles: Pick<Profile, "display_name"> | null;
};

const METADATA_DESCRIPTION_MAX = 160;

function truncateForMetadata(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const supabase = await createClient();

  const { data: book } = await supabase
    .from("books")
    .select("title, description, status, cover_path")
    .eq("id", id)
    .maybeSingle<Pick<Book, "title" | "description" | "status" | "cover_path">>();

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
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // With migration 024 applied, RLS itself now permits fetching an
  // unpublished book's row for its author OR a legitimate (non-refunded)
  // owner -- not just the author, as before. So the fetch below can
  // succeed for either, and ownership has to be known before the
  // visibility gate can tell them apart from an unrelated authenticated
  // reader, for whom RLS will have already returned no row at all.
  const { data: book } = await supabase
    .from("books")
    .select("*, profiles(display_name, bio)")
    .eq("id", id)
    .single<BookWithAuthorBio>();

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

  const { data: reviews } = await supabase
    .from("reviews")
    .select("*, profiles(display_name)")
    .eq("book_id", id)
    .order("created_at", { ascending: false })
    .returns<ReviewWithReader[]>();

  const allReviews = reviews ?? [];
  const reviewCount = allReviews.length;
  const averageRating =
    reviewCount > 0
      ? allReviews.reduce((sum, r) => sum + r.rating, 0) / reviewCount
      : 0;
  const myReview = user
    ? (allReviews.find((r) => r.reader_id === user.id) ?? null)
    : null;

  const coverUrl = book.cover_path
    ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
    : null;

  // A basic view count, not deduplicated unique visitors — a reload or
  // a repeat visit counts again. Only published books, and never the
  // author's own visits (so previewing/editing doesn't inflate it).
  // Admin client because this is a system-recorded event, not something
  // tied to the viewer's own RLS-governed rows.
  if (book.status === "published" && !isAuthor) {
    const admin = createAdminClient();
    await admin.from("book_views").insert({ book_id: id });
  }

  const { data: contributors } = await supabase
    .from("book_contributors")
    .select("*")
    .eq("book_id", id)
    .order("created_at")
    .returns<Contributor[]>();

  let seriesInfo: Series | null = null;
  let seriesEntries: SeriesEntry[] = [];
  if (book.series_id) {
    const { data: seriesRow } = await supabase
      .from("series")
      .select("*")
      .eq("id", book.series_id)
      .maybeSingle<Series>();
    seriesInfo = seriesRow;

    const { data: entries } = await supabase
      .from("books")
      .select("id, title, series_position")
      .eq("series_id", book.series_id)
      .eq("status", "published")
      .order("series_position", { ascending: true, nullsFirst: false })
      .returns<SeriesEntry[]>();
    seriesEntries = entries ?? [];
  }

  const { data: moreByAuthor } = await supabase
    .from("books")
    .select("*, profiles(display_name)")
    .eq("status", "published")
    .eq("author_id", book.author_id)
    .neq("id", id)
    .order("created_at", { ascending: false })
    .limit(8)
    .returns<BookWithAuthor[]>();

  let youMightLike: BookWithAuthor[] = [];
  if (book.genre) {
    const { data } = await supabase
      .from("books")
      .select("*, profiles(display_name)")
      .eq("status", "published")
      .eq("genre", book.genre)
      .neq("id", id)
      .neq("author_id", book.author_id)
      .order("created_at", { ascending: false })
      .limit(8)
      .returns<BookWithAuthor[]>();
    youMightLike = data ?? [];
  }

  const purchaseState = resolveBookPurchaseState({
    user: user ? { id: user.id } : null,
    isAuthor,
    owned,
    priceCents: book.price_cents,
  });
  const formattedPrice = formatPrice(book.price_cents);

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
              <span className="font-medium">{seriesInfo.title}</span>
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
              formattedPrice={formattedPrice}
              wishlisted={wishlisted}
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
      {(book.description || book.preview_text || book.keywords) && (
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="font-serif text-xl font-semibold">About this book</h2>
          {book.description && (
            <p className="mt-4 max-w-prose whitespace-pre-line text-foreground/90">
              {book.description}
            </p>
          )}

          {book.preview_text && (
            <details className="mt-4 max-w-prose rounded-lg border border-border bg-surface p-4 shadow-sm">
              <summary className="focus-ring cursor-pointer rounded-sm font-serif font-medium">
                Look inside
              </summary>
              <p className="mt-3 whitespace-pre-line text-sm text-foreground/90">
                {book.preview_text}
              </p>
            </details>
          )}

          {book.keywords && (
            <ul className="mt-4 flex max-w-prose flex-wrap gap-2">
              {book.keywords
                .split(",")
                .map((k) => k.trim())
                .filter(Boolean)
                .map((keyword) => (
                  <li
                    key={keyword}
                    className="rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted"
                  >
                    {keyword}
                  </li>
                ))}
            </ul>
          )}
        </section>
      )}

      {/* ============================================================
          Book Details
          ============================================================ */}
      <section className="mt-12 border-t border-border pt-8">
        <h2 className="font-serif text-xl font-semibold">Book Details</h2>
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:max-w-md">
          <div>
            <dt className="text-muted">Format</dt>
            <dd className="mt-0.5">Ebook · EPUB</dd>
          </div>
          {book.genre && (
            <div>
              <dt className="text-muted">Genre</dt>
              <dd className="mt-0.5">{book.genre}</dd>
            </div>
          )}
          {seriesInfo && (
            <div>
              <dt className="text-muted">Series</dt>
              <dd className="mt-0.5">
                {book.series_position ? `Book ${book.series_position} of ` : ""}
                {seriesInfo.title}
              </dd>
            </div>
          )}
          {book.isbn && (
            <div>
              <dt className="text-muted">ISBN</dt>
              <dd className="mt-0.5">{book.isbn}</dd>
            </div>
          )}
        </dl>
      </section>

      {/* ============================================================
          About the Author
          ============================================================ */}
      <section className="mt-12 border-t border-border pt-8">
        <h2 className="font-serif text-xl font-semibold">About the Author</h2>
        <p className="mt-3 font-serif text-lg font-medium">{book.profiles?.display_name}</p>
        {book.profiles?.bio && (
          <p className="mt-2 max-w-prose text-sm text-foreground/90">{book.profiles.bio}</p>
        )}
        <Link
          href={`/authors/${book.author_id}`}
          className="focus-ring mt-3 inline-block rounded-sm text-sm font-medium text-primary hover:underline"
        >
          View author profile &rarr;
        </Link>
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
          Series entries
          ============================================================ */}
      {seriesInfo && seriesEntries.length > 1 && (
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="font-serif text-xl font-semibold">
            {seriesInfo.title}
          </h2>
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
        title="More by this author"
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
  formattedPrice,
  wishlisted,
}: {
  state: BookPurchaseState;
  bookId: string;
  formattedPrice: string;
  wishlisted: boolean;
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
      <Link href={`/login?next=/books/${bookId}`} className={buttonClasses("primary", "md")}>
        {state === "anonymous-free" ? "Log in to get this book" : "Log in to buy"}
      </Link>
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
    </div>
  );
}
