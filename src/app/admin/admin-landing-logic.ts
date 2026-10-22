// Pure helpers for the /admin "Today" page -- deliberately separated
// from page.tsx so what the page shows for each permission is directly
// unit-testable without a JSX render harness, same extraction technique
// used throughout this codebase's admin/authorization logic
// (decideStaffAccess, report-review-logic.ts, refund-review-logic.ts).
//
// ADMIN-1 (A2 look): the landing page's row of link buttons became the
// "Today" page (the menu now carries every link). Each tile mirrors the
// exact permission its own destination route enforces (reports.view for
// /admin/reports, refunds.view for /admin/refunds) -- never admin.access
// alone, since admin.access only proves "some staff member," not which
// specific surfaces they may enter. Recent activity needs audit.view,
// the permission /admin/audit and list_admin_audit_events() require.
// Counts only: no amount is ever shown here (money figures arrive with
// the live POK build).

export function resolveTodayVisibility(permissions: {
  reportsView: boolean;
  refundsView: boolean;
  auditView: boolean;
}): { showReports: boolean; showRefunds: boolean; showActivity: boolean } {
  return {
    showReports: permissions.reportsView,
    showRefunds: permissions.refundsView,
    showActivity: permissions.auditView,
  };
}

// Librum's admins work on Albanian time, whatever time zone the server
// runs in.
export const TODAY_TIME_ZONE = "Europe/Tirane";

/** "Monday 19 October" -- the page's eyebrow. */
export function formatTodayEyebrow(now: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: TODAY_TIME_ZONE,
  })
    .format(now)
    .replace(",", "");
}

/** "17 Oct 2026" -- when a report or refund request came in. */
export function formatTodayDate(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: TODAY_TIME_ZONE,
  }).format(new Date(iso));
}

/** "19 Oct, 09:41" -- when an audit event happened. */
export function formatActivityTime(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: TODAY_TIME_ZONE,
  }).format(new Date(iso));
}

/** The small line under a tile's number. `oldestAt` is the oldest waiting item. */
export function describeTileWaiting(count: number, oldestAt: string | null): string {
  if (count === 0 || !oldestAt) return "Nothing waiting";
  return `Oldest: ${formatTodayDate(oldestAt)}`;
}

// ADMIN-2-TAKEDOWN (E, S7): "2 days ago" -- how long a report has been
// waiting, in plain English. Under a minute "just now"; under an hour in
// minutes; under a day in hours; then in calendar days on Albanian time
// ("yesterday", "2 days ago"). A time in the future (clock skew) reads
// "just now".
const RELATIVE_TIME = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function tiraneDayNumber(date: Date): number {
  const [year, month, day] = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: TODAY_TIME_ZONE,
  })
    .format(date)
    .split("-")
    .map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function formatRelativeTime(iso: string, now: Date): string {
  const then = new Date(iso);
  const elapsedMs = now.getTime() - then.getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 60_000) return "just now";
  if (elapsedMs < 3_600_000) return RELATIVE_TIME.format(-Math.floor(elapsedMs / 60_000), "minute");
  if (elapsedMs < 86_400_000) return RELATIVE_TIME.format(-Math.floor(elapsedMs / 3_600_000), "hour");
  const days = Math.max(1, tiraneDayNumber(now) - tiraneDayNumber(then));
  return RELATIVE_TIME.format(-days, "day");
}

// ADMIN-2-TAKEDOWN (E, S7): a report's own reason, shortened for the To
// do row ("Copyright report on ..."). The readers' reasons are
// src/lib/report-reasons.ts; any other (legacy) value is shown as is.
const SHORT_REPORT_REASONS: Record<string, string> = {
  "Copyright infringement": "Copyright",
  "Inappropriate or offensive content": "Content",
  "Spam or misleading listing": "Spam",
  Other: "Other",
};

export function shortReportReason(reason: string | null | undefined): string {
  if (!reason) return "Other";
  return SHORT_REPORT_REASONS[reason] ?? reason;
}

export type TodayReport = { id: string; created_at: string; reason: string | null; bookTitle: string | null };
export type TodayRefund = { id: string; requested_at: string; readerName: string };

export type TodoItem = {
  key: string;
  href: string;
  title: string;
  detail: string;
  actionLabel: string;
  at: string;
};

export const TODO_LIMIT = 5;

/**
 * The "To do" list: open reports and waiting refund requests merged,
 * oldest first (reports by created_at, refunds by requested_at), at
 * most TODO_LIMIT rows. Each row opens the detail page where the staff
 * member acts on it. No amounts.
 *
 * ADMIN-2-TAKEDOWN (E, ADMIN-1 "1. a"): a report row reads
 * `<Reason> report on “<Title>”, <relative time>`, e.g. "Copyright report
 * on “Kënga e fundit”, 2 days ago". Refund rows are unchanged.
 */
export function buildTodoItems(
  reports: readonly TodayReport[],
  refunds: readonly TodayRefund[],
  limit: number = TODO_LIMIT,
  now: Date = new Date(),
): TodoItem[] {
  const items: TodoItem[] = [
    ...reports.map((report) => ({
      key: `report-${report.id}`,
      href: `/admin/reports/${report.id}`,
      title: `${shortReportReason(report.reason)} report on “${report.bookTitle ?? "Book unavailable"}”, ${formatRelativeTime(report.created_at, now)}`,
      detail: `Reported ${formatTodayDate(report.created_at)}`,
      actionLabel: "Review report",
      at: report.created_at,
    })),
    ...refunds.map((refund) => ({
      key: `refund-${refund.id}`,
      href: `/admin/refunds/${refund.id}`,
      title: `Refund request from ${refund.readerName}`,
      detail: `Requested ${formatTodayDate(refund.requested_at)}`,
      actionLabel: "Review request",
      at: refund.requested_at,
    })),
  ];
  // Compared as instants, not strings: created_at and requested_at come
  // from two tables and need not share one text format.
  items.sort((a, b) => {
    const diff = Date.parse(a.at) - Date.parse(b.at);
    return diff !== 0 ? diff : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return items.slice(0, Math.max(0, limit));
}
