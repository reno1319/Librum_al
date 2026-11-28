import { StarRating } from "@/components/star-rating";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import {
  ANONYMOUS_REVIEWER_NAME,
  AUTHOR_REVIEWER_LABEL,
  VERIFIED_PURCHASE_LABEL,
} from "@/lib/reader-reviews";
import { reviewerInitials } from "@/lib/review-summary";
import type { PublicReview } from "@/lib/types";

// Amazon book page, patch 3 (item 18, design r7): one review -- the
// reviewer's initials in a circle and the review name, then the stars,
// then the date with the "Blerje e verifikuar" / "Autor në Librum" tags,
// then the text. Shared by the book page and the all-reviews page.
// (Review titles are patch 6, with the database change.)
export function ReviewListItem({ review }: { review: PublicReview }) {
  return (
    <li data-review="" className="border-t border-border py-4 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2.5 text-sm">
        <span
          aria-hidden="true"
          className="flex size-[2.125rem] shrink-0 items-center justify-center rounded-full bg-[#d9e2dc] text-[0.8125rem] font-semibold text-foreground/70"
        >
          {reviewerInitials(review.reviewer_name)}
        </span>
        <span className="font-semibold text-foreground">{review.reviewer_name ?? ANONYMOUS_REVIEWER_NAME}</span>
      </div>
      <div className="mt-1.5">
        <StarRating rating={review.rating} />
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[0.8125rem] text-muted">
        {/* REVIEW-DATE: the day the reader first wrote it (created_at,
            already in public_reviews), in Tirana, same Albanian format
            as "Botuar në Librum". An edit keeps this date. */}
        <time dateTime={review.created_at}>{formatTimestampAsDate(review.created_at)}</time>
        {review.verified && (
          <span className="rounded-[3px] bg-green-50 px-1.5 py-0.5 text-xs font-semibold text-green-800">
            {VERIFIED_PURCHASE_LABEL}
          </span>
        )}
        {review.reviewer_is_author && (
          <span className="rounded-[3px] border border-border px-1.5 py-0.5 text-xs font-medium text-muted">
            {AUTHOR_REVIEWER_LABEL}
          </span>
        )}
      </div>
      {review.body && <p className="mt-1.5 max-w-[42.5rem] text-sm leading-6 text-foreground">{review.body}</p>}
    </li>
  );
}
