import Link from "next/link";
import { reviewsPageHref, starLabel, type ReviewSummary } from "@/lib/review-summary";

// Amazon book page, patch 3 (items 15 + 26, design r7): the 5 -> 1 star
// rows with a bar and a percent. Each row with reviews is a link to the
// all-reviews page showing only that many stars (bp4 a); a row with no
// reviews is plain text. Used in the reviews block, the star pop-up and
// the all-reviews page (where the chosen row is marked).
export function ReviewHistogram({
  bookId,
  summary,
  activeStars = null,
  className = "",
}: {
  bookId: string;
  summary: ReviewSummary;
  activeStars?: number | null;
  className?: string;
}) {
  return (
    <ul data-review-histogram="" className={`grid gap-2 ${className}`}>
      {summary.buckets.map((bucket) => {
        const label = starLabel(bucket.stars);
        const active = activeStars === bucket.stars;
        return (
          <li key={bucket.stars} className="grid grid-cols-[3.25rem_minmax(0,1fr)_2.5rem] items-center gap-2.5 text-sm">
            {bucket.count > 0 ? (
              <Link
                href={reviewsPageHref(bookId, { stars: bucket.stars })}
                aria-current={active ? "true" : undefined}
                className={`focus-ring inline-flex min-h-8 items-center rounded-sm text-primary underline underline-offset-2 hover:decoration-2 ${active ? "font-semibold" : ""}`}
              >
                {label}
              </Link>
            ) : (
              <span className="text-muted">{label}</span>
            )}
            <span aria-hidden="true" className="h-4 overflow-hidden rounded-[4px] border border-[#d9d3c3] bg-[#faf7f0]">
              <span className="block h-full bg-[#d99a00]" style={{ width: `${bucket.percent}%` }} />
            </span>
            <span className="text-right text-foreground">{`${bucket.percent}%`}</span>
          </li>
        );
      })}
    </ul>
  );
}
