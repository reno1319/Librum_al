import Link from "next/link";
import { requireStaff } from "@/lib/staff";
import { roleHasPermission } from "@/lib/staff-permissions";
import { createClient } from "@/lib/supabase/server";
import { resolvePaidCheckoutMode, resolvePaidPublishingMode } from "@/lib/paid-readiness";
import {
  buildTodoItems,
  describeTileWaiting,
  formatActivityTime,
  formatTodayEyebrow,
  resolveTodayVisibility,
  TODO_LIMIT,
  type TodayRefund,
  type TodayReport,
  type TodayReview,
} from "../admin-landing-logic";
import { resolveProfileDisplayName } from "./refunds/refund-review-logic";
import { listAdminAuditEvents } from "./audit/actions";
import { getActionLabel, resolveAuditActorDisplay } from "./audit/audit-log-logic";
import { readBookTitlesForStaff, readPendingReviewsForStaff } from "./books/admin-book-reads";
import type { AuditEventRow } from "@/lib/types";
import { loadStaffDisplayNames } from "@/lib/staff-display-names";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Today",
};

// Reads the paid-mode environment variables and today's date on every
// request, so this page must never be statically cached.
export const dynamic = "force-dynamic";

type OpenReportRow = {
  id: string;
  created_at: string;
  reason: string | null;
  book_id: string | null;
};

type WaitingRefundRow = {
  id: string;
  reader_id: string | null;
  requested_at: string;
};

// ADMIN-1A: requireStaff("admin.access") is the page's own gate (the
// (protected) layout runs the same check). requireStaff() returns only
// { userId, role }; everything below is derived from that role via the
// pure roleHasPermission() the SQL-side staff_has_permission() is kept
// in sync with -- no separate hasPermission() calls.
//
// ADMIN-1 (A2 look): this is now the "Today" page. Status chips, a tile
// per queue the role may open, a merged oldest-first "To do" list and,
// for audit.view holders, the five latest audit events. Each tile and
// to-do row is shown only when the role holds the permission its
// destination route enforces, and each query runs only then too, so a
// role never asks the database for rows it may not open. Counts only:
// no amount is selected or shown (money figures arrive with the live
// POK build).
export default async function AdminPage() {
  const { role } = await requireStaff("admin.access");

  const { showReports, showRefunds, showActivity, showReviews } = resolveTodayVisibility({
    reportsView: roleHasPermission(role, "reports.view"),
    refundsView: roleHasPermission(role, "refunds.view"),
    auditView: roleHasPermission(role, "audit.view"),
    booksReview: roleHasPermission(role, "books.review"),
  });

  // Labels only, from `.allowed`: the resolvers' reasons and the raw
  // environment values never reach the page.
  const paidPublishingOn = resolvePaidPublishingMode(process.env).allowed;
  const paidCheckoutOn = resolvePaidCheckoutMode(process.env).allowed;

  const supabase = await createClient();

  // The same filter the Book reports page counts as "open"
  // (reports/page.tsx: status === "open"), applied in the query; RLS
  // ("Staff with reports.view can view all book reports") is the
  // database-side gate behind this permission check.
  const reportsResult = showReports
    ? await supabase
        .from("book_reports")
        .select("id, created_at, reason, book_id")
        .eq("status", "open")
        .order("created_at", { ascending: true })
        .returns<OpenReportRow[]>()
    : null;

  // Only `requested` waits for a decision; `approved` is already decided
  // (refunds/page.tsx's "awaiting review" count). No amount column is
  // selected.
  const refundsResult = showRefunds
    ? await supabase
        .from("refund_requests")
        .select("id, reader_id, requested_at")
        .eq("status", "requested")
        .order("requested_at", { ascending: true })
        .returns<WaitingRefundRow[]>()
    : null;

  // ADMIN-3-REVIEW (I): books waiting for review, oldest first, for
  // books.review only. Read with the service-role client after
  // requireStaff (staff sessions cannot read review rows); the oldest
  // TODO_LIMIT rows plus the total for the tile.
  const reviewsResult = showReviews ? await readPendingReviewsForStaff(TODO_LIMIT) : undefined;
  const reviewsFailed = reviewsResult === null;
  const todoReviews: TodayReview[] = reviewsResult?.items ?? [];

  const openReports = reportsResult?.data ?? [];
  const waitingRefunds = refundsResult?.data ?? [];
  const reportsFailed = Boolean(reportsResult?.error);
  const refundsFailed = Boolean(refundsResult?.error);

  // Reader names for the refund rows the To do list can show.
  // PEN-NAMES-2 (MF3): through staff_profile_display_names(), as the
  // Refund requests page does -- support no longer reads profiles.
  const readerIds = Array.from(
    new Set(waitingRefunds.map((r) => r.reader_id).filter((id): id is string => id !== null)),
  );
  const displayNameById = await loadStaffDisplayNames(supabase, readerIds);

  // ADMIN-2-TAKEDOWN (M2): the titles come from the service-role client
  // (requireStaff has passed above, and these rows exist only for
  // reports.view), so a report on a draft or taken-down book never reads
  // "Book unavailable" -- whether or not PEN-NAMES-2's contract step
  // (staff books policy, 13a) has run yet. Only the rows the To do list
  // can show are looked up; a failed read falls back to that text.
  const todoReportRows = openReports.slice(0, TODO_LIMIT);
  const reportTitles = await readBookTitlesForStaff(
    todoReportRows.map((r) => r.book_id).filter((id): id is string => id !== null),
  );
  const todoReports: TodayReport[] = todoReportRows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    reason: r.reason,
    bookTitle: reportTitles.ok && r.book_id ? (reportTitles.titleById.get(r.book_id) ?? null) : null,
  }));
  const todoRefunds: TodayRefund[] = waitingRefunds.map((r) => ({
    id: r.id,
    requested_at: r.requested_at,
    readerName: resolveProfileDisplayName({
      profileId: r.reader_id,
      displayNameById,
      whenNull: "a deleted account",
      whenMissing: "an unknown reader",
    }),
  }));
  const todoItems = buildTodoItems(todoReports, todoRefunds, TODO_LIMIT, new Date(), todoReviews);

  const activityResult = showActivity ? await listAdminAuditEvents({ limit: 5 }) : null;
  const activity: AuditEventRow[] = activityResult?.ok ? activityResult.data : [];

  const tiles = [
    showReviews && {
      key: "reviews",
      href: "/admin/books?status=in_review",
      label: "Books waiting for review",
      failed: reviewsFailed,
      count: reviewsResult?.total ?? 0,
      oldestAt: todoReviews[0]?.submittedAt ?? null,
    },
    showReports && {
      key: "reports",
      href: "/admin/reports",
      label: "Open book reports",
      failed: reportsFailed,
      count: openReports.length,
      oldestAt: openReports[0]?.created_at ?? null,
    },
    showRefunds && {
      key: "refunds",
      href: "/admin/refunds",
      label: "Refund requests waiting",
      failed: refundsFailed,
      count: waitingRefunds.length,
      oldestAt: waitingRefunds[0]?.requested_at ?? null,
    },
  ].filter((tile) => tile !== false);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-7 px-4 py-6 sm:px-6 md:px-10 md:py-9">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold tracking-[0.14em] text-[#806510] uppercase md:text-[0.8125rem]">
            {formatTodayEyebrow(new Date())}
          </p>
          <h1 className="mt-1 font-serif text-[2rem] font-bold text-primary md:mt-1.5 md:text-[2.5rem]">Today</h1>
        </div>
        <ul aria-label="Status" className="flex flex-wrap gap-2 text-[0.8125rem]">
          <li className="rounded-control border border-control px-2.5 py-1.5">
            Paid publishing: <strong>{paidPublishingOn ? "On" : "Off"}</strong>
          </li>
          <li className="rounded-control border border-control px-2.5 py-1.5">
            Paid checkout: <strong>{paidCheckoutOn ? "On" : "Off"}</strong>
          </li>
        </ul>
      </div>

      {tiles.length > 0 && (
        <section aria-label="Waiting" className="grid grid-cols-2 gap-2.5 md:grid-cols-4 md:gap-4">
          {tiles.map((tile) => (
            <Link
              key={tile.key}
              href={tile.href}
              className="focus-ring rounded-card border border-border bg-surface p-3.5 text-foreground transition-colors hover:bg-surface-hover md:p-[1.125rem]"
            >
              <p className="text-[0.8125rem] text-muted">{tile.label}</p>
              <p className="mt-1.5 font-serif text-[1.625rem] font-bold text-[#806510] md:mt-2 md:text-[1.875rem]">
                {tile.failed ? "—" : tile.count}
              </p>
              <p className="mt-1 text-[0.8125rem] text-muted">
                {tile.failed ? "Couldn’t load. Open the page to check." : describeTileWaiting(tile.count, tile.oldestAt)}
              </p>
            </Link>
          ))}
        </section>
      )}

      <div className="flex flex-wrap gap-6">
        <section
          aria-labelledby="today-todo"
          className="min-w-0 flex-[3_1_420px] rounded-card border border-border bg-surface p-4 md:p-6"
        >
          <h2 id="today-todo" className="font-serif text-[1.375rem] font-bold text-primary md:text-2xl">
            To do
          </h2>
          <p className="mt-1 mb-4 text-sm text-muted">Oldest first. Each item opens the page where you act on it.</p>
          {(reportsFailed || refundsFailed || reviewsFailed) && (
            <p role="alert" className="mb-3 text-sm text-red-700">
              Some items couldn’t be loaded. Open Books, Book reports or Refund requests to check.
            </p>
          )}
          {todoItems.length === 0 ? (
            <p className="border-t border-border pt-4 text-sm text-muted">Nothing waiting.</p>
          ) : (
            <ul className="flex flex-col">
              {todoItems.map((item) => (
                <li
                  key={item.key}
                  className="flex flex-col gap-2.5 border-t border-border py-3.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3"
                >
                  <div className="min-w-0">
                    <p className="font-semibold break-words">{item.title}</p>
                    <p className="mt-0.5 text-sm text-muted">{item.detail}</p>
                  </div>
                  <Link
                    href={item.href}
                    className="focus-ring inline-flex min-h-12 items-center justify-center rounded-control bg-primary px-[1.125rem] text-[0.9375rem] font-semibold text-primary-foreground transition-colors hover:bg-primary-hover sm:min-h-11"
                  >
                    {item.actionLabel}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>

        {showActivity && (
          <section
            aria-labelledby="today-activity"
            className="min-w-0 flex-[2_1_300px] rounded-card border border-border bg-surface p-4 md:p-6"
          >
            <h2 id="today-activity" className="mb-4 font-serif text-[1.375rem] font-bold text-primary md:text-2xl">
              Recent activity
            </h2>
            {activityResult && !activityResult.ok ? (
              <p role="alert" className="text-sm text-red-700">
                {activityResult.error}
              </p>
            ) : activity.length === 0 ? (
              <p className="text-sm text-muted">No admin actions yet.</p>
            ) : (
              <ul className="flex flex-col gap-3.5 text-sm">
                {activity.map((event) => (
                  <li key={event.id}>
                    <span className="text-muted">{formatActivityTime(event.created_at)}</span> ·{" "}
                    {resolveAuditActorDisplay(event.actor_display_name)}: {getActionLabel(event.action)}
                  </li>
                ))}
              </ul>
            )}
            <Link
              href="/admin/audit"
              className="focus-ring mt-4 inline-flex min-h-11 items-center rounded-sm text-sm font-semibold text-primary underline underline-offset-2 hover:decoration-2"
            >
              Full audit log
            </Link>
          </section>
        )}
      </div>
    </main>
  );
}
