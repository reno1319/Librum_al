import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { resolveMaintenanceMode } from "@/lib/maintenance-mode";
import { MaintenanceNotice } from "@/components/maintenance-notice";
import { StarRating } from "@/components/star-rating";
import { ReviewHistogram } from "@/components/review-histogram";
import { ReviewListItem } from "@/components/review-list-item";
import { isPreorder } from "@/lib/preorder-reader";
import {
  REVIEWS_PER_PAGE,
  formatAverage,
  parseReviewsPage,
  parseStarFilter,
  reviewCountLabel,
  reviewsPageCount,
  reviewsPageHref,
  starLabel,
  summarizeReviews,
} from "@/lib/review-summary";
import type { PublicReview } from "@/lib/types";

// Amazon book page, patch 3 (item 19, bp4 a): every approved review of
// a book, newest first, 10 per page (?faqja=N), and the star filter
// (?yjet=1..5) the 5 -> 1 rows link to. Same visibility as the book
// page: a live book or pre-order for everyone; otherwise only its author
// and readers who own it. No database change: public_reviews (approved
// reviews only, no reader id) as on the book page.
export const metadata: Metadata = {
  title: "Vlerësimet e lexuesve",
  robots: { index: false },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGER_LINK =
  "focus-ring inline-flex min-h-11 items-center justify-center rounded-full border border-foreground bg-surface px-4 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover md:min-h-8";

export default async function BookReviewsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ yjet?: string | string[]; faqja?: string | string[] }>;
}) {
  if (resolveMaintenanceMode(process.env.ALL_CUTOVER_MAINTENANCE_MODE)) {
    return <MaintenanceNotice />;
  }

  const { id } = await params;
  const { yjet, faqja } = await searchParams;
  if (!UUID.test(id)) notFound();
  const stars = parseStarFilter(yjet);
  const page = parseReviewsPage(faqja);
  if (page === null) notFound();

  const supabase = await createClient();
  const [
    {
      data: { user },
    },
    { data: book },
  ] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from("public_books")
      .select("id, title, status")
      .eq("id", id)
      .maybeSingle<{ id: string; title: string; status: string }>(),
  ]);
  if (!book) notFound();

  // The book page's own gate: published or a live pre-order for all;
  // otherwise only the author (own-row read) or a reader who owns it.
  if (book.status !== "published" && !isPreorder(book)) {
    let allowed = false;
    if (user) {
      const [{ data: ownRow }, { data: owns }] = await Promise.all([
        supabase.from("books").select("id").eq("id", id).eq("author_id", user.id).maybeSingle(),
        supabase.rpc("user_owns_book", { target_book_id: id }),
      ]);
      allowed = !!ownRow || !!owns;
    }
    if (!allowed) notFound();
  }

  const from = (page - 1) * REVIEWS_PER_PAGE;
  let listQuery = supabase
    .from("public_reviews")
    .select("id, book_id, rating, body, created_at, reviewer_name, verified, reviewer_is_author", { count: "exact" })
    .eq("book_id", id);
  if (stars) listQuery = listQuery.eq("rating", stars);

  const [{ data: ratingRows }, { data: pageRows, count }] = await Promise.all([
    supabase.from("public_reviews").select("rating").eq("book_id", id).returns<{ rating: number }[]>(),
    listQuery
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(from, from + REVIEWS_PER_PAGE - 1)
      .returns<PublicReview[]>(),
  ]);

  const summary = summarizeReviews((ratingRows ?? []).map((r) => r.rating));
  const shownTotal = count ?? 0;
  const pageCount = reviewsPageCount(shownTotal);
  if (page > pageCount) notFound();
  const reviews = pageRows ?? [];

  return (
    <main className="page-container flex-1 pt-4 pb-16 sm:pt-5">
      <Link
        href={`/libra/${id}`}
        className="focus-ring rounded-sm text-sm text-muted underline underline-offset-2 hover:decoration-2"
      >
        &larr; Kthehuni te libri
      </Link>
      <h1 className="mt-2 text-[1.75rem] leading-9 font-normal text-foreground">Vlerësimet e lexuesve</h1>
      <p className="mt-1 text-sm text-muted">
        për{" "}
        <Link href={`/libra/${id}`} className="focus-ring rounded-sm font-medium text-primary underline underline-offset-2 hover:decoration-2">
          {book.title}
        </Link>
      </p>

      {summary.count === 0 ? (
        <p className="mt-6 text-[0.9375rem] text-muted">Ende pa vlerësime.</p>
      ) : (
        <div className="mt-6 grid gap-8 lg:grid-cols-[17.875rem_minmax(0,1fr)] lg:gap-x-[3.125rem]">
          <div data-review-summary="">
            <p className="flex items-center gap-2.5 text-xl leading-7">
              <span className="text-[1.375rem]"><StarRating rating={summary.average} /></span>
              <b className="font-bold text-foreground">{`${formatAverage(summary.average)} nga 5`}</b>
            </p>
            <p className="mt-1 text-sm text-muted">{reviewCountLabel(summary.count)}</p>
            <ReviewHistogram bookId={id} summary={summary} activeStars={stars} className="mt-3.5" />
            <p className="mt-3 text-[0.8125rem] leading-5 text-muted">
              Klikoni një rresht yjesh për të parë vetëm ato vlerësime.
            </p>
          </div>

          <div data-review-list="">
            <p className="mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted">
              <span>
                {stars
                  ? `Vetëm ${starLabel(stars)} · ${reviewCountLabel(shownTotal)}`
                  : `Më të rejat · ${reviewCountLabel(shownTotal)}`}
              </span>
              {stars && (
                <Link
                  href={reviewsPageHref(id)}
                  className="focus-ring inline-flex min-h-8 items-center rounded-sm font-medium text-primary underline underline-offset-2 hover:decoration-2"
                >
                  Shiko të gjitha
                </Link>
              )}
            </p>
            {reviews.length === 0 ? (
              <p className="text-[0.9375rem] text-muted">{`Asnjë vlerësim me ${starLabel(stars ?? 0)}.`}</p>
            ) : (
              <ul className="flex flex-col">
                {reviews.map((review) => (
                  <ReviewListItem key={review.id} review={review} />
                ))}
              </ul>
            )}

            {pageCount > 1 && (
              <nav aria-label="Faqet e vlerësimeve" className="mt-6 flex flex-wrap items-center gap-3 text-sm">
                {page > 1 && (
                  <Link href={reviewsPageHref(id, { stars, page: page - 1 })} className={PAGER_LINK}>
                    &larr; Më parë
                  </Link>
                )}
                <span className="text-muted">{`Faqja ${page} nga ${pageCount}`}</span>
                {page < pageCount && (
                  <Link href={reviewsPageHref(id, { stars, page: page + 1 })} className={PAGER_LINK}>
                    Më tej &rarr;
                  </Link>
                )}
              </nav>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
