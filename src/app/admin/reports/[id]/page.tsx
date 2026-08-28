import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { BookReportStatus } from "@/lib/types";
import {
  ADMIN_NOTES_MAX_LENGTH,
  REPORT_STATUS_LABELS,
  canReview,
  resolveProfileDisplayName,
} from "../report-review-logic";
import { reviewBookReport } from "../actions";
import { ReportReviewButtons } from "./report-review-buttons";
import type { Metadata } from "next";

// LIBRUM 2.0 LAUNCH-FIX-1B MOD-1: static title, not a dynamic one built
// from the reported book's title -- same reasoning as the refund detail
// page's own metadata (admin-only page, not worth a second fetch).
export const metadata: Metadata = {
  title: "Book report",
};

// book_id is the only foreign key from book_reports to books, so this
// embed is unambiguous -- unlike reporter_id/reviewed_by, both of which
// point at profiles and are resolved separately below (see this
// module's own comment on resolveProfileDisplayName). books comes back
// null whenever the row isn't visible to this admin under books' own
// RLS (published, or the admin's own book, or one they own) -- the
// exact same "Book unavailable" situation the refund admin detail page
// already handles; see that page's own comment and section 13 of the
// MOD-1 brief, which explicitly asks for this precedent to be followed
// rather than bypassed.
type AdminBookReportDetail = {
  id: string;
  book_id: string;
  reporter_id: string;
  reason: string;
  details: string;
  status: BookReportStatus;
  created_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  admin_notes: string | null;
  books: { title: string; author_id: string; status: "draft" | "published" } | null;
};

export default async function AdminBookReportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; success?: string }>;
}) {
  const { id } = await params;
  const { error, success } = await searchParams;

  // src/app/admin/layout.tsx already gates this whole route.
  const supabase = await createClient();

  const { data: report } = await supabase
    .from("book_reports")
    .select(
      "id, book_id, reporter_id, reason, details, status, created_at, reviewed_at, reviewed_by, admin_notes, books(title, author_id, status)",
    )
    .eq("id", id)
    .maybeSingle<AdminBookReportDetail>();

  // Either the id doesn't exist, or (defense in depth -- shouldn't
  // happen given the admin-scoped RLS policy already grants visibility
  // into every row) RLS denied it. A 404 is the correct, honest
  // response -- not a crash.
  if (!report) {
    notFound();
  }

  // book_reports has THREE separate foreign keys into profiles
  // (reporter_id, reviewed_by, and the reported book's own author_id)
  // -- one flat, explicit lookup for all three ids at once, same
  // technique the refund admin pages already use for reader_id/
  // reviewed_by. Only the ids actually present are looked up (the
  // book's author_id is only available when the books embed resolved).
  const profileIds = Array.from(
    new Set(
      [report.reporter_id, report.reviewed_by, report.books?.author_id ?? null].filter(
        (v): v is string => v !== null,
      ),
    ),
  );
  const { data: profiles } =
    profileIds.length > 0
      ? await supabase.from("profiles").select("id, display_name").in("id", profileIds)
      : { data: [] };
  const displayNameById = new Map((profiles ?? []).map((p) => [p.id, p.display_name]));

  // reporter_id is not-null and ON DELETE CASCADE (migration 009): a
  // report row can never outlive its reporter's profile, so
  // "whenMissing" is defensive/unreachable in practice, not an
  // expected case -- handled the same honest way as everywhere else in
  // this app rather than assumed away.
  const reporterDisplayName = resolveProfileDisplayName({
    profileId: report.reporter_id,
    displayNameById,
    whenNull: "Unknown reporter",
    whenMissing: "Unknown reporter (account no longer available)",
  });
  const reviewerDisplayName = resolveProfileDisplayName({
    profileId: report.reviewed_by,
    displayNameById,
    whenNull: "Not yet reviewed",
    whenMissing: "Unknown reviewer (account no longer available)",
  });
  const authorDisplayName = report.books
    ? resolveProfileDisplayName({
        profileId: report.books.author_id,
        displayNameById,
        whenNull: "Unknown author",
        whenMissing: "Unknown author (account no longer available)",
      })
    : null;

  const reviewable = canReview(report.status);

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10 sm:px-6">
      <Link href="/admin/reports" className="text-sm text-muted hover:underline">
        &larr; Back to book reports
      </Link>
      <h1 className="mt-2 font-serif text-3xl font-semibold">Book report</h1>

      {error && (
        <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      {success && (
        <p className="mt-4 rounded-lg bg-green-50 px-3 py-2 text-sm text-green-700">{success}</p>
      )}

      <div className="mt-6 rounded-lg border border-border bg-surface p-4 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium">{report.books?.title ?? "Book unavailable"}</p>
            {authorDisplayName && <p className="text-xs text-muted">by {authorDisplayName}</p>}
          </div>
          <span className="text-sm font-semibold">{REPORT_STATUS_LABELS[report.status]}</span>
        </div>

        {report.books && (
          <p className="mt-2 text-xs text-muted">
            {report.books.status === "published" ? (
              <Link href={`/books/${report.book_id}`} className="text-primary underline">
                View public book page
              </Link>
            ) : (
              "Not currently published"
            )}
          </p>
        )}

        <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted">Reporter</dt>
          <dd className="font-medium">{reporterDisplayName}</dd>

          <dt className="text-muted">Reason</dt>
          <dd>{report.reason}</dd>

          <dt className="text-muted">Submitted</dt>
          <dd>
            {new Date(report.created_at).toLocaleString(undefined, {
              year: "numeric",
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </dd>

          <dt className="text-muted">Reviewed</dt>
          <dd>
            {report.reviewed_at
              ? new Date(report.reviewed_at).toLocaleString(undefined, {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })
              : "Not yet reviewed"}
          </dd>

          {report.reviewed_at && (
            <>
              <dt className="text-muted">Reviewed by</dt>
              <dd>{reviewerDisplayName}</dd>
            </>
          )}
        </dl>

        {report.details && (
          <div className="mt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">
              Reporter&apos;s details
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{report.details}</p>
          </div>
        )}

        {report.admin_notes && (
          <div className="mt-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Admin notes</p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{report.admin_notes}</p>
          </div>
        )}
      </div>

      {reviewable && (
        <form className="mt-6 rounded-lg border border-border bg-surface p-4 shadow-sm">
          <label className="flex flex-col gap-1 text-sm">
            Admin notes (optional)
            <textarea
              name="adminNotes"
              rows={3}
              maxLength={ADMIN_NOTES_MAX_LENGTH}
              className="rounded-lg border border-border bg-surface px-3 py-2"
            />
          </label>
          <ReportReviewButtons
            onResolve={reviewBookReport.bind(null, report.id, "resolved")}
            onDismiss={reviewBookReport.bind(null, report.id, "dismissed")}
          />
        </form>
      )}
    </main>
  );
}
