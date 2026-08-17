import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { buyBook, submitReview, addToWishlist, removeFromWishlist } from "./actions";
import { StarRating } from "@/components/star-rating";
import { BookShelf } from "@/components/book-shelf";
import { CONTRIBUTOR_ROLE_VERB } from "@/lib/contributor-roles";
import type { Book, Profile, Review, Series, Contributor } from "@/lib/types";

type BookWithAuthor = Book & { profiles: Pick<Profile, "display_name"> | null };
type SeriesEntry = Pick<Book, "id" | "title" | "series_position">;
type ReviewWithReader = Review & {
  profiles: Pick<Profile, "display_name"> | null;
};

export default async function BookDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    purchase?: string;
    review?: string;
    report?: string;
    error?: string;
  }>;
}) {
  const { id } = await params;
  const { purchase, review: reviewStatus, report: reportStatus, error } =
    await searchParams;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: book } = await supabase
    .from("books")
    .select("*, profiles(display_name)")
    .eq("id", id)
    .single<BookWithAuthor>();

  if (!book || (book.status !== "published" && book.author_id !== user?.id)) {
    notFound();
  }

  let owned = false;
  let wishlisted = false;
  if (user) {
    const { data: purchaseRow } = await supabase
      .from("purchases")
      .select("id")
      .eq("book_id", id)
      .eq("reader_id", user.id)
      .is("refunded_at", null)
      .maybeSingle();
    owned = !!purchaseRow;

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

  const isAuthor = user?.id === book.author_id;
  const coverUrl = book.cover_path
    ? supabase.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl
    : null;

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
              alt=""
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

          {seriesInfo && (
            <p className="mt-1 text-sm text-muted">
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

          {purchase === "success" && (
            <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">
              Purchase complete — thank you! It may take a few seconds to show
              as owned below.
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

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <span className="text-xl font-semibold text-primary">
              ${(book.price_cents / 100).toFixed(2)}
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
                Log in to buy
              </Link>
            )}
          </div>
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
