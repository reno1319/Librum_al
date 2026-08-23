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
import type { Book, Profile, Review, Series, Contributor } from "@/lib/types";

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

  const title = `${book.title} — Librum`;
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
      title,
      description,
      type: "book",
      ...(coverUrl ? { images: [{ url: coverUrl }] } : {}),
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
    .select("*, profiles(display_name)")
    .eq("id", id)
    .single<BookWithAuthor>();

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

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <div className="flex flex-col gap-8 sm:flex-row">
        <div className="mx-auto w-48 shrink-0 sm:mx-0 sm:w-56">
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
          <h1 className="font-serif text-3xl font-semibold">{book.title}</h1>
          <p className="mt-1 text-sm text-muted">
            by{" "}
            <Link
              href={`/authors/${book.author_id}`}
              className="hover:underline"
            >
              {book.profiles?.display_name}
            </Link>
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <span className="text-xl font-semibold text-primary">
              {book.price_cents === 0
                ? "Free"
                : `$${(book.price_cents / 100).toFixed(2)}`}
            </span>

            {isAuthor ? (
              <>
                <span className="text-sm text-muted">This is your book</span>
                <a
                  href={`/api/books/${book.id}/download`}
                  className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-hover"
                >
                  Download EPUB
                </a>
              </>
            ) : owned ? (
              <>
                <span className="rounded-lg bg-surface-hover px-4 py-2 text-sm font-medium">
                  You own this book
                </span>
                <a
                  href={`/api/books/${book.id}/download`}
                  className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
                >
                  Download EPUB
                </a>
              </>
            ) : user ? (
              <>
                {book.price_cents === 0 ? (
                  <form action={getFreeBook.bind(null, book.id)}>
                    <button
                      type="submit"
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
                    >
                      Get this book
                    </button>
                  </form>
                ) : (
                  <form
                    action={buyBook.bind(null, book.id)}
                    className="flex items-center gap-2"
                  >
                    <input
                      name="code"
                      type="text"
                      placeholder="Promo code (optional)"
                      className="w-40 rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                    />
                    <button
                      type="submit"
                      className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
                    >
                      Buy now
                    </button>
                  </form>
                )}
                <form
                  action={(wishlisted ? removeFromWishlist : addToWishlist).bind(
                    null,
                    book.id,
                  )}
                >
                  <button
                    type="submit"
                    className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-hover"
                  >
                    {wishlisted ? "Remove from wishlist" : "Save for later"}
                  </button>
                </form>
              </>
            ) : (
              <Link
                href={`/login?next=/books/${book.id}`}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
              >
                {book.price_cents === 0 ? "Log in to get this book" : "Log in to buy"}
              </Link>
            )}
          </div>

          {!isAuthor && book.status !== "published" && owned && (
            <p className="mt-2 text-xs font-medium text-amber-700">
              This book is no longer available for sale. You can still
              download your copy anytime.
            </p>
          )}

          {!isAuthor && !owned && (
            <p className="mt-2 text-xs text-muted">
              {book.price_cents === 0
                ? "Free — no payment required. You'll get a DRM-free EPUB you can download anytime from your Librum Library."
                : "DRM-free EPUB. Download it anytime from your Librum Library."}
            </p>
          )}

          {purchase === "success" && (
            <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
              {owned ? (
                <>
                  Purchase complete — thank you!{" "}
                  <Link href="/library" className="font-medium underline">
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
                  <Link href="/library" className="font-medium underline">
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

          {seriesInfo && (
            <p className="mt-4 text-sm text-muted">
              {book.series_position ? `Book ${book.series_position} of ` : ""}
              the <span className="font-medium">{seriesInfo.title}</span> series
            </p>
          )}

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

          <div className="mt-2 flex items-center gap-2 text-sm">
            <StarRating rating={averageRating} />
            <span className="text-muted">
              {reviewCount > 0
                ? `${averageRating.toFixed(1)} · ${reviewCount} review${reviewCount === 1 ? "" : "s"}`
                : "No reviews yet"}
            </span>
          </div>

          <p className="mt-4 whitespace-pre-line text-foreground/90">
            {book.description}
          </p>

          {book.keywords && (
            <ul
              className="mt-3 flex flex-wrap"
              style={{ gap: "0.5rem" }}
            >
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

          {book.isbn && (
            <p className="mt-3 text-xs text-muted">ISBN: {book.isbn}</p>
          )}

          {book.preview_text && (
            <details className="mt-4 rounded-lg border border-border bg-surface p-4 shadow-sm">
              <summary className="cursor-pointer font-serif font-medium">
                Look inside
              </summary>
              <p className="mt-3 whitespace-pre-line text-sm text-foreground/90">
                {book.preview_text}
              </p>
            </details>
          )}
        </div>
      </div>

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
                className="rounded-lg border border-border bg-surface px-3 py-2"
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
                className="rounded-lg border border-border bg-surface px-3 py-2"
              />
            </label>
            <button
              type="submit"
              className="w-fit rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
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

      {seriesInfo && seriesEntries.length > 1 && (
        <section className="mt-12 border-t border-border pt-8">
          <h2 className="font-serif text-xl font-semibold">
            {seriesInfo.title}
          </h2>
          <ol
            className="text-sm"
            style={{ display: "flex", flexDirection: "column", gap: "0.5rem", marginTop: "1rem" }}
          >
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
                    className="hover:underline"
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

      {user && !isAuthor && (
        <p className="mt-8 text-xs text-muted">
          <Link href={`/books/${book.id}/report`} className="hover:underline">
            Report this book
          </Link>
        </p>
      )}
    </main>
  );
}
