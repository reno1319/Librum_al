import Link from "next/link";
import { notFound } from "next/navigation";
import { requireStaff } from "@/lib/staff";
import { roleHasPermission } from "@/lib/staff-permissions";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePublicAuthorName } from "@/lib/author-name";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { takedownReasonForReport, takedownReasonLabel } from "@/lib/takedown-reasons";
import {
  BUYER_FILE_ONLY_HISTORY_LABEL,
  GRANDFATHERED_HISTORY_LABEL,
  REVIEW_CHECKLIST_ITEMS,
  REVIEW_STATUS_LABELS,
  type BookReviewStatus,
} from "@/lib/book-review-copy";
import { Alert } from "@/components/ui/alert";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import type { Metadata } from "next";
import { formatActivityTime, formatRelativeTime, formatTodayDate } from "../../../admin-landing-logic";
import { describeBookEyebrow, isUuid, resolveTakedownReport } from "../book-admin-logic";
import {
  allowBookAgainAsStaff,
  approveBookReviewAsStaff,
  sendBackBookReviewAsStaff,
  unpublishBookAsStaff,
} from "../actions";
import { UnpublishForm } from "./unpublish-form";
import { SendBackForm } from "./send-back-form";

export const metadata: Metadata = {
  title: "Book",
};

// Reads the book's live state on every request.
export const dynamic = "force-dynamic";

// ADMIN-2-TAKEDOWN (C), per the mockup's "Book page with Unpublish": the
// book (cover, state, title, author, published date -- no sales count:
// free downloads create purchase rows too), its open reports, its rights
// history, and the Unpublish panel. requireStaff("reports.view") is the
// gate; every read then uses the service-role client, because a staff
// session cannot see drafts (M2). The panel, and both of its actions,
// need reports.resolve. Opened from a report (?report=<id>), the form
// carries that report only when it is an OPEN report of this book.
//
// ADMIN-3-REVIEW (H): when the book is waiting for review, the right
// column opens with "Review this book" -- the file link, the cover, the
// four checks, Approve and publish, and Send back -- for books.review
// staff only (owner, admin); other staff see that it is in review,
// read-only. The left column adds the review history (newest first).

type AdminBook = {
  id: string;
  title: string;
  status: string;
  price_all: number | null;
  published_at: string | null;
  cover_path: string | null;
  file_path: string | null;
  author_id: string;
  pen_name_id: string | null;
  pen: { name: string } | null;
};

type OpenReport = { id: string; reason: string; details: string; created_at: string };

type RightsRow = {
  declared_at: string;
  author_public_name: string;
  pen_name: string | null;
  statement_text: string;
};

type ReviewRow = {
  id: string;
  status: BookReviewStatus;
  grandfathered: boolean;
  buyer_file_only: boolean;
  submitted_at: string;
  decided_at: string | null;
  decided_by: string | null;
  reason: string | null;
  file_path: string | null;
  cover_path: string | null;
};

type ActiveTakedown = {
  reason: string;
  message_to_author: string;
  bundle_ids: string[];
  taken_down_by: string | null;
  taken_down_at: string;
};

const SECTION_CLASSES = "rounded-card border border-border bg-surface p-5";
const SECTION_HEADING_CLASSES = "mb-2.5 font-serif text-[1.375rem] font-bold text-primary";

export default async function AdminBookPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ report?: string | string[]; error?: string; success?: string }>;
}) {
  const { role } = await requireStaff("reports.view");
  const canResolve = roleHasPermission(role, "reports.resolve");
  const canReview = roleHasPermission(role, "books.review");

  const { id } = await params;
  const { report: reportParam, error, success } = await searchParams;
  if (!isUuid(id)) notFound();

  const admin = createAdminClient();
  const { data: book } = await admin
    .from("books")
    .select("id, title, status, price_all, published_at, cover_path, file_path, author_id, pen_name_id, pen:pen_names(name)")
    .eq("id", id)
    .maybeSingle<AdminBook>();
  if (!book) notFound();

  const [profileResult, reportsResult, rightsResult, takedownResult, bundlesResult, reviewsResult, suspensionResult] = await Promise.all([
    admin
      .from("profiles")
      .select("display_name, public_author_name")
      .eq("id", book.author_id)
      .maybeSingle<{ display_name: string | null; public_author_name: string | null }>(),
    admin
      .from("book_reports")
      .select("id, reason, details, created_at")
      .eq("book_id", book.id)
      .eq("status", "open")
      .order("created_at", { ascending: true })
      .returns<OpenReport[]>(),
    admin
      .from("book_rights_declarations")
      .select("declared_at, author_public_name, pen_name, statement_text")
      .eq("book_id", book.id)
      .order("declared_at", { ascending: false })
      .returns<RightsRow[]>(),
    admin
      .from("book_takedowns")
      .select("reason, message_to_author, bundle_ids, taken_down_by, taken_down_at")
      .eq("book_id", book.id)
      .is("lifted_at", null)
      .maybeSingle<ActiveTakedown>(),
    admin
      .from("bundle_books")
      .select("bundle_id, bundles!inner(title, status)")
      .eq("book_id", book.id)
      .eq("bundles.status", "published")
      .returns<{ bundle_id: string; bundles: { title: string; status: string } }[]>(),
    admin
      .from("book_reviews")
      .select("id, status, grandfathered, buyer_file_only, submitted_at, decided_at, decided_by, reason, file_path, cover_path")
      .eq("book_id", book.id)
      .order("submitted_at", { ascending: false })
      .returns<ReviewRow[]>(),
    // PEOPLE-2 (N3, Renato's 4b): the "Suspended" badge. Information
    // only: Approve is refused by the database (LB464) either way.
    admin
      .from("account_suspensions")
      .select("id")
      .eq("user_id", book.author_id)
      .is("lifted_at", null)
      .maybeSingle<{ id: string }>(),
  ]);
  if (suspensionResult.error) {
    console.error("admin book: the author suspension read failed", { error: suspensionResult.error });
  }
  const authorSuspended = Boolean(suspensionResult.data);

  const openReports = reportsResult.data ?? [];
  const rights = rightsResult.data ?? [];
  const takedown = takedownResult.data;
  // Fail closed: when the takedown state cannot be read, neither panel
  // is offered (the RPCs would decide on their own anyway).
  const takedownUnknown = Boolean(takedownResult.error);
  const publishedBundleTitles = (bundlesResult.data ?? []).map((row) => row.bundles.title);
  const reviews = reviewsResult.data ?? [];
  const pendingReview = book.status === "draft" ? (reviews.find((r) => r.status === "pending") ?? null) : null;
  // S6 / 6: the pending snapshot must still be the book's current files.
  const pendingIsCurrent =
    pendingReview !== null &&
    pendingReview.file_path === book.file_path &&
    pendingReview.cover_path === book.cover_path;
  const deciderIds = Array.from(new Set(reviews.map((r) => r.decided_by).filter((v): v is string => !!v)));
  const decidersResult =
    deciderIds.length > 0
      ? await admin.from("profiles").select("id, display_name").in("id", deciderIds).returns<{ id: string; display_name: string | null }[]>()
      : { data: [] as { id: string; display_name: string | null }[] };
  const deciderName = new Map((decidersResult.data ?? []).map((p) => [p.id, p.display_name ?? "a staff member"]));

  const [takenByResult, takenDownBundlesResult] = takedown
    ? await Promise.all([
        takedown.taken_down_by
          ? admin
              .from("profiles")
              .select("display_name")
              .eq("id", takedown.taken_down_by)
              .maybeSingle<{ display_name: string | null }>()
          : Promise.resolve({ data: null }),
        takedown.bundle_ids.length > 0
          ? admin.from("bundles").select("id, title").in("id", takedown.bundle_ids).returns<{ id: string; title: string }[]>()
          : Promise.resolve({ data: [] as { id: string; title: string }[] }),
      ])
    : [null, null];
  const takenByName = takenByResult?.data?.display_name ?? "a former staff member";
  const takenDownBundleTitles = (() => {
    const titleById = new Map((takenDownBundlesResult?.data ?? []).map((b) => [b.id, b.title]));
    return (takedown?.bundle_ids ?? []).map((bundleId) => titleById.get(bundleId)).filter((t): t is string => !!t);
  })();

  // As reports/[id] does: the public name the book carries (its pen
  // name), and the account's own name when it differs.
  const profile = profileResult.data;
  const publicName = book.pen?.name ?? resolvePublicAuthorName(profile) ?? "Unknown author";
  const accountName = profile?.display_name ?? null;

  const formReport = resolveTakedownReport(reportParam, openReports);
  const coverUrl = book.cover_path ? admin.storage.from("covers").getPublicUrl(book.cover_path).data.publicUrl : null;
  const now = new Date();

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-wrap items-start gap-6 px-4 py-6 sm:px-6 md:px-10 md:py-9">
      <div className="flex min-w-0 flex-[3_1_420px] flex-col gap-5">
        <Link
          href="/admin/books"
          className="focus-ring inline-flex min-h-11 items-center self-start rounded-sm text-sm text-primary underline underline-offset-2 hover:decoration-2"
        >
          &larr; All books
        </Link>

        {error && <Alert variant="error">{error}</Alert>}
        {success && <Alert variant="success">{success}</Alert>}

        <div className="flex gap-4 sm:gap-5">
          {coverUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={coverUrl} alt="" className="h-[120px] w-20 shrink-0 rounded-[3px] object-cover sm:h-36 sm:w-24" />
          ) : (
            <CoverPlaceholder title={book.title} authorName={publicName} className="h-[120px] w-20 shrink-0 rounded-[3px] sm:h-36 sm:w-24" />
          )}
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-[0.14em] text-[#806510] uppercase md:text-[0.8125rem]">
              {describeBookEyebrow(book, Boolean(takedown), pendingReview !== null)}
            </p>
            {authorSuspended && (
              <p className="mt-1.5 flex flex-wrap items-center gap-x-3">
                <span className="rounded-[3px] bg-[#f6e3df] px-2 py-1 text-xs font-bold tracking-wide text-[#8e2a1e] uppercase">
                  Suspended
                </span>
                <Link
                  href={`/admin/people/${book.author_id}`}
                  className="focus-ring inline-flex min-h-11 items-center text-sm underline underline-offset-2"
                >
                  Open the author&apos;s account
                </Link>
              </p>
            )}
            <h1 className="mt-1.5 mb-1 font-serif text-[1.75rem] leading-tight font-bold break-words text-primary md:text-[2.125rem]">
              {book.title}
            </h1>
            <p className="text-[0.9375rem]">
              by {publicName}
              {book.published_at && ` · published ${formatTimestampAsDate(book.published_at)}`}
            </p>
            {accountName && accountName !== publicName && (
              <p className="mt-0.5 text-sm text-muted">Account name: {accountName}</p>
            )}
            {book.status === "published" && (
              <Link href={`/libra/${book.id}`} className="mt-1 inline-flex min-h-11 items-center text-sm text-primary underline">
                View public book page
              </Link>
            )}
          </div>
        </div>

        <section aria-labelledby="book-open-reports" className={SECTION_CLASSES}>
          <h2 id="book-open-reports" className={SECTION_HEADING_CLASSES}>
            {openReports.length === 1 ? "Open report" : "Open reports"}
          </h2>
          {reportsResult.error ? (
            <p className="text-sm text-red-700">Couldn’t load the reports.</p>
          ) : openReports.length === 0 ? (
            <p className="text-sm text-muted">No open reports.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {openReports.map((report) => (
                <li key={report.id} className="border-t border-border pt-3 first:border-t-0 first:pt-0">
                  <p className="text-[0.9375rem] break-words">
                    <strong>{report.reason}:</strong>{" "}
                    {report.details ? `“${report.details}”` : <span className="text-muted">No details given.</span>}
                  </p>
                  <p className="mt-1 text-sm text-muted">From a reader · {formatTodayDate(report.created_at)}</p>
                  <Link
                    href={`/admin/reports/${report.id}`}
                    className="mt-1 inline-flex min-h-11 items-center text-sm font-semibold text-primary underline underline-offset-2"
                  >
                    Open report
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="book-rights-history" className={SECTION_CLASSES}>
          <h2 id="book-rights-history" className={SECTION_HEADING_CLASSES}>
            Rights history
          </h2>
          {rightsResult.error ? (
            <p className="text-sm text-red-700">Couldn’t load the rights history.</p>
          ) : rights.length === 0 ? (
            <p className="text-sm text-muted">No rights statement on record.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {rights.map((row, index) => (
                <li key={`${row.declared_at}-${index}`} className="break-words">
                  {formatActivityTime(row.declared_at)} · {row.pen_name ?? row.author_public_name} chose “{row.statement_text}”
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="book-review-history" className={SECTION_CLASSES}>
          <h2 id="book-review-history" className={SECTION_HEADING_CLASSES}>
            Review history
          </h2>
          {reviewsResult.error ? (
            <p className="text-sm text-red-700">Couldn’t load the review history.</p>
          ) : reviews.length === 0 ? (
            <p className="text-sm text-muted">Never sent for review.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {reviews.map((review) => (
                <li key={review.id} className="break-words">
                  {formatActivityTime(review.decided_at ?? review.submitted_at)} ·{" "}
                  {review.buyer_file_only
                    ? BUYER_FILE_ONLY_HISTORY_LABEL
                    : review.grandfathered
                      ? GRANDFATHERED_HISTORY_LABEL
                      : REVIEW_STATUS_LABELS[review.status]}
                  {review.reason && ` · ${takedownReasonLabel(review.reason)}`}
                  {review.decided_by && ` · by ${deciderName.get(review.decided_by) ?? "a former staff member"}`}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="flex min-w-0 flex-[2_1_340px] flex-col gap-5">
        {reviewsResult.error ? (
          <section aria-labelledby="book-review" className="flex flex-col gap-3 rounded-card border-2 border-primary bg-surface p-5 md:p-6">
            <h2 id="book-review" className="font-serif text-2xl font-bold text-primary">
              Review this book
            </h2>
            <p className="text-sm text-red-700">Couldn’t check whether this book is waiting for review. Please reload the page.</p>
          </section>
        ) : pendingReview ? (
          <section aria-labelledby="book-review" className="flex flex-col gap-4 rounded-card border-2 border-primary bg-surface p-5 md:p-6">
            <h2 id="book-review" className="font-serif text-2xl font-bold text-primary">
              {canReview ? "Review this book" : "In review"}
            </h2>
            <p className="text-[0.9375rem]">
              Sent {formatRelativeTime(pendingReview.submitted_at, now)} by {publicName}.
            </p>
            {authorSuspended && (
              <p className="text-sm text-red-700">
                This author&apos;s account is suspended. Approving is refused until the suspension is lifted. Send back
                still works.
              </p>
            )}
            {!canReview ? (
              <p className="text-sm text-muted">Only owners and admins can approve or send back a book.</p>
            ) : !pendingIsCurrent ? (
              <p className="text-sm text-red-700">
                The author changed the file or cover after sending it. They need to send it for review again.
              </p>
            ) : (
              <>
                <div className="flex items-start gap-4">
                  {coverUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={coverUrl} alt="The cover sent for review" className="h-24 w-16 shrink-0 rounded-[3px] object-cover" />
                  ) : (
                    <CoverPlaceholder title={book.title} authorName={publicName} className="h-24 w-16 shrink-0 rounded-[3px]" />
                  )}
                  <a
                    href={`/admin/books/${book.id}/file?review=${pendingReview.id}`}
                    className="focus-ring inline-flex min-h-11 items-center text-[0.9375rem] font-semibold text-primary underline underline-offset-2 hover:decoration-2"
                  >
                    Open the book file
                  </a>
                </div>
                <form action={approveBookReviewAsStaff} className="flex flex-col gap-3">
                  <input type="hidden" name="bookId" value={book.id} />
                  <input type="hidden" name="reviewId" value={pendingReview.id} />
                  <input type="hidden" name="filePath" value={pendingReview.file_path ?? ""} />
                  <input type="hidden" name="coverPath" value={pendingReview.cover_path ?? ""} />
                  <fieldset className="flex flex-col gap-1">
                    <legend className="mb-1 text-[0.9375rem] font-semibold">Check before you approve</legend>
                    {REVIEW_CHECKLIST_ITEMS.map((item) => (
                      <label key={item.key} className="flex min-h-11 items-center gap-3 text-[0.9375rem]">
                        <input type="checkbox" name={item.key} required className="size-5 shrink-0 accent-primary" />
                        {item.label}
                      </label>
                    ))}
                  </fieldset>
                  <button
                    type="submit"
                    className="focus-ring inline-flex min-h-11 items-center justify-center self-start rounded-[3px] bg-primary px-[1.125rem] text-[0.9375rem] font-semibold text-primary-foreground hover:opacity-90"
                  >
                    Approve and publish
                  </button>
                </form>
                <SendBackForm action={sendBackBookReviewAsStaff} bookId={book.id} reviewId={pendingReview.id} />
                <p className="text-[0.8125rem] text-muted">Saved in the Audit log with your name, the time and the reason.</p>
              </>
            )}
          </section>
        ) : null}

        <section
          aria-labelledby="book-unpublish"
          className="flex min-w-0 flex-col gap-4 rounded-card border-2 border-primary bg-surface p-5 md:p-6"
        >
          {takedownUnknown ? (
            <>
              <h2 id="book-unpublish" className="font-serif text-2xl font-bold text-primary">
                Unpublish this book
              </h2>
              <p className="text-sm text-red-700">Couldn’t check whether this book is taken down. Please reload the page.</p>
            </>
          ) : takedown ? (
            <>
              <h2 id="book-unpublish" className="font-serif text-2xl font-bold text-primary">
                Taken down
              </h2>
              <p className="text-[0.9375rem]">
                Taken down {formatRelativeTime(takedown.taken_down_at, now)} by {takenByName}.
              </p>
              <dl className="flex flex-col gap-3 text-sm">
                <div>
                  <dt className="font-semibold">Reason</dt>
                  <dd>{takedownReasonLabel(takedown.reason)}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Message sent to the author</dt>
                  <dd className="whitespace-pre-wrap break-words">{takedown.message_to_author}</dd>
                </div>
                <div>
                  <dt className="font-semibold">Bundles unpublished</dt>
                  <dd>{takenDownBundleTitles.length > 0 ? takenDownBundleTitles.join(", ") : "None"}</dd>
                </div>
              </dl>
              <p className="text-sm text-muted">
                The author can&apos;t publish it again until you allow it. Readers who already bought it keep it.
              </p>
              {canResolve && (
                <form action={allowBookAgainAsStaff.bind(null, book.id)}>
                  <button
                    type="submit"
                    className="focus-ring inline-flex min-h-11 items-center justify-center rounded-[3px] border border-primary bg-surface px-[1.125rem] text-[0.9375rem] font-semibold text-primary hover:bg-surface-hover"
                  >
                    Allow the author to publish again
                  </button>
                </form>
              )}
            </>
          ) : canResolve ? (
            <>
              <h2 id="book-unpublish" className="font-serif text-2xl font-bold text-primary">
                Unpublish this book
              </h2>
              {/* SMALL-FIXES-1 (2a, audit A5): a draft is not in the Bookstore,
                  so it can't "leave" it; a takedown also cancels a waiting review. */}
              {book.status === "draft" ? (
                <p className="text-sm text-muted">
                  The book stays out of the Bookstore. The author can&apos;t publish it until you allow it. Readers who
                  already bought it keep it.
                  {pendingReview && " This also cancels the waiting review."}
                </p>
              ) : (
                <p className="text-sm text-muted">
                  The book leaves the Bookstore at once. The author can&apos;t publish it again until you allow it.
                  Readers who already bought it keep it.
                </p>
              )}
              {publishedBundleTitles.length > 0 && (
                <p className="text-sm font-semibold">This also unpublishes: {publishedBundleTitles.join(", ")}.</p>
              )}
              <UnpublishForm
                action={unpublishBookAsStaff}
                bookId={book.id}
                reportId={formReport?.id ?? null}
                defaultReason={takedownReasonForReport(formReport?.reason)}
              />
              <p className="text-[0.8125rem] text-muted">Saved in the Audit log with your name, the time and the reason.</p>
            </>
          ) : (
            <>
              <h2 id="book-unpublish" className="font-serif text-2xl font-bold text-primary">
                Unpublish this book
              </h2>
              <p className="text-sm text-muted">Only staff who can resolve reports can unpublish a book.</p>
            </>
          )}
        </section>
      </div>
    </main>
  );
}
