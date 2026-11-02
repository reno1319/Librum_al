import Link from "next/link";
import type { Metadata } from "next";
import { requireStaff } from "@/lib/staff";
import { createClient } from "@/lib/supabase/server";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { Alert } from "@/components/ui/alert";
import { pageErrorMessage, pageSuccessMessage } from "@/lib/page-messages";
import {
  REVIEW_NOTE_MAX,
  REVIEW_REJECTION_LABELS_EN,
  REVIEW_REJECTION_REASONS,
} from "@/lib/reader-reviews";
import {
  approveReaderReviewAsStaff,
  rejectReaderReviewAsStaff,
} from "./actions";
import { accountAgeLabel, reviewCountLabel } from "./reader-review-logic";

export const metadata: Metadata = {
  title: "Reader reviews",
};

// Lists the live queue on every request.
export const dynamic = "force-dynamic";

// BD13: every reader review waits here until staff approve it (3a);
// owner, admin and moderator decide (Q3a, reports.resolve). Oldest
// first. Each row shows what helps spot a fake review (5a): how old the
// account is, whether its email is confirmed, how many reviews it has
// written, and whether it paid for this book. Rejecting needs a reason
// from the fixed list (Q6a), and a note for "Other"; the reader sees
// both on the book page (Q4a). The form carries the updated_at staff
// saw, so a review the reader edited in the meantime is not decided
// blind.

type PendingReaderReview = {
  review_id: string;
  book_id: string;
  book_title: string | null;
  reader_id: string;
  rating: number;
  body: string | null;
  review_name: string | null;
  updated_at: string;
  account_created_at: string | null;
  email_confirmed: boolean;
  reviews_total: number;
  reviews_approved: number;
  verified: boolean;
  reviewer_is_author: boolean;
};

const LOAD_ERROR = "Couldn't load the reviews. Please try again.";

export default async function AdminReaderReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { userId } = await requireStaff("reports.resolve");

  const { error: rawError, success: rawSuccess } = await searchParams;
  const errorMessage = pageErrorMessage(rawError);
  const success = pageSuccessMessage(rawSuccess);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "staff_list_pending_reader_reviews",
  );
  if (error)
    console.error("admin reader reviews: list failed", { code: error.code });
  const reviews = (data as PendingReaderReview[] | null) ?? [];
  const now = new Date();

  return (
    <main className="mx-auto flex w-full min-w-0 max-w-4xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 md:px-10 md:py-9">
      <div>
        <h1 className="font-serif text-[2rem] font-bold text-primary md:text-[2.5rem]">
          Reader reviews
        </h1>
        <p className="mt-1 text-sm text-muted">
          {error ? "—" : reviews.length} waiting. A review shows on the book
          page only after it is approved. Never reject a review for being
          negative: only for the reasons in the list.
        </p>
      </div>

      {success && <Alert variant="success">{success}</Alert>}
      {errorMessage && <Alert variant="error">{errorMessage}</Alert>}
      {error && <Alert variant="error">{LOAD_ERROR}</Alert>}

      {!error && reviews.length === 0 ? (
        <p className="rounded-card border border-dashed border-border px-6 py-16 text-center text-muted">
          No reviews waiting.
        </p>
      ) : (
        <ul className="flex flex-col gap-4">
          {reviews.map((review) => (
            <li
              key={review.review_id}
              className="rounded-card border border-border bg-surface p-5"
            >
              <p className="text-sm text-muted">
                <Link
                  href={`/libra/${review.book_id}`}
                  className="font-semibold text-primary underline underline-offset-2"
                >
                  {review.book_title ?? "Unknown book"}
                </Link>{" "}
                · sent {formatTimestampAsDate(review.updated_at)}
              </p>
              <p className="mt-2 font-semibold break-words">
                {review.review_name ?? "No name yet"}{" "}
                <span
                  aria-label={`${review.rating} out of 5 stars`}
                  className="text-[#806510]"
                >
                  {"★".repeat(review.rating)}
                  {"☆".repeat(5 - review.rating)}
                </span>
              </p>
              {review.body ? (
                <p className="mt-2 break-words whitespace-pre-line">
                  {review.body}
                </p>
              ) : (
                <p className="mt-2 text-sm text-muted">Stars only, no text.</p>
              )}

              <ul
                aria-label="About the reviewer"
                className="mt-3 flex flex-wrap gap-2 text-[0.8125rem]"
              >
                <li className="rounded-control border border-control px-2 py-1">
                  Account {accountAgeLabel(review.account_created_at, now)}
                </li>
                <li className="rounded-control border border-control px-2 py-1">
                  {review.email_confirmed
                    ? "Email confirmed"
                    : "Email NOT confirmed"}
                </li>
                <li className="rounded-control border border-control px-2 py-1">
                  {reviewCountLabel(
                    review.reviews_total,
                    review.reviews_approved,
                  )}
                </li>
                <li className="rounded-control border border-control px-2 py-1">
                  {review.verified
                    ? "Paid for this book"
                    : "Free or 100% discount (no badge)"}
                </li>
                {review.reviewer_is_author && (
                  <li className="rounded-control border border-control px-2 py-1">
                    Also an author on Librum
                  </li>
                )}
              </ul>

              {review.reader_id === userId ? (
                <p className="mt-4 border-t border-border pt-4 text-sm text-muted">
                  This is your own review. Another staff member approves or
                  rejects it.
                </p>
              ) : (
                <div className="mt-4 flex flex-col gap-4 border-t border-border pt-4 md:flex-row md:items-start md:justify-between">
                  <form action={approveReaderReviewAsStaff}>
                    <input
                      type="hidden"
                      name="review_id"
                      value={review.review_id}
                    />
                    <input
                      type="hidden"
                      name="seen"
                      value={review.updated_at}
                    />
                    <input
                      type="hidden"
                      name="book_id"
                      value={review.book_id}
                    />
                    <button
                      type="submit"
                      className="focus-ring min-h-11 rounded-control bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary-hover"
                    >
                      Approve
                    </button>
                  </form>

                  <form
                    action={rejectReaderReviewAsStaff}
                    className="flex min-w-0 flex-1 flex-col gap-2 md:max-w-md"
                  >
                    <input
                      type="hidden"
                      name="review_id"
                      value={review.review_id}
                    />
                    <input
                      type="hidden"
                      name="seen"
                      value={review.updated_at}
                    />
                    <input
                      type="hidden"
                      name="book_id"
                      value={review.book_id}
                    />
                    <label className="flex flex-col gap-1 text-sm font-semibold">
                      Reason
                      <select
                        name="reason"
                        required
                        defaultValue=""
                        className="min-h-11 rounded-control border border-control px-2 font-normal"
                      >
                        <option value="" disabled>
                          Choose a reason
                        </option>
                        {REVIEW_REJECTION_REASONS.map((reason) => (
                          <option key={reason} value={reason}>
                            {REVIEW_REJECTION_LABELS_EN[reason]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="flex flex-col gap-1 text-sm font-semibold">
                      Note to the reader, in Albanian (shown on the book page;
                      required for “Other”)
                      <textarea
                        name="note"
                        rows={2}
                        maxLength={REVIEW_NOTE_MAX}
                        className="rounded-control border border-control px-3 py-2 font-normal"
                      />
                    </label>
                    <button
                      type="submit"
                      className="focus-ring min-h-11 self-start rounded-control border border-control px-4 text-sm font-semibold hover:bg-surface-hover"
                    >
                      Reject
                    </button>
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
