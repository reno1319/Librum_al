import { describe, expect, it } from "vitest";
import {
  buildTodoItems,
  describeTileWaiting,
  formatActivityTime,
  formatRelativeTime,
  formatTodayDate,
  formatTodayEyebrow,
  resolveTodayVisibility,
  shortReportReason,
  TODO_LIMIT,
  type TodayRefund,
  type TodayReport,
} from "./admin-landing-logic";
import { roleHasPermission } from "@/lib/staff-permissions";
import type { StaffRole } from "@/lib/types";

// ADMIN-1 (A2 look): the "Today" page's pure decisions, per role,
// deriving each role's real permissions from the canonical matrix
// (roleHasPermission) rather than hand-picking booleans, so this test
// fails if the matrix and the page's visibility logic ever disagree.
function visibilityFor(role: StaffRole) {
  return resolveTodayVisibility({
    reportsView: roleHasPermission(role, "reports.view"),
    refundsView: roleHasPermission(role, "refunds.view"),
    auditView: roleHasPermission(role, "audit.view"),
  });
}

describe("resolveTodayVisibility", () => {
  it("owner and admin: both tiles and recent activity", () => {
    for (const role of ["owner", "admin"] as StaffRole[]) {
      expect(visibilityFor(role)).toEqual({ showReports: true, showRefunds: true, showActivity: true });
    }
  });

  it("moderator: the reports tile only", () => {
    expect(visibilityFor("moderator")).toEqual({ showReports: true, showRefunds: false, showActivity: false });
  });

  it("support: the refunds tile only", () => {
    expect(visibilityFor("support")).toEqual({ showReports: false, showRefunds: true, showActivity: false });
  });

  it("editor: no tiles and no activity", () => {
    expect(visibilityFor("editor")).toEqual({ showReports: false, showRefunds: false, showActivity: false });
  });

  it("each flag follows exactly its own permission", () => {
    for (const reportsView of [true, false]) {
      for (const refundsView of [true, false]) {
        for (const auditView of [true, false]) {
          expect(resolveTodayVisibility({ reportsView, refundsView, auditView })).toEqual({
            showReports: reportsView,
            showRefunds: refundsView,
            showActivity: auditView,
          });
        }
      }
    }
  });
});

describe("dates on Albanian time", () => {
  it("the eyebrow is the weekday and date in Tirana, not the server's zone", () => {
    expect(formatTodayEyebrow(new Date("2026-10-19T09:00:00Z"))).toBe("Monday 19 October");
    // 23:30 UTC on the 19th is already Tuesday in Tirana (UTC+2 in summer time).
    expect(formatTodayEyebrow(new Date("2026-10-19T23:30:00Z"))).toBe("Tuesday 20 October");
    // After summer time ends (25 October), Tirana is UTC+1.
    expect(formatTodayEyebrow(new Date("2026-11-02T22:30:00Z"))).toBe("Monday 2 November");
    expect(formatTodayEyebrow(new Date("2026-11-02T23:30:00Z"))).toBe("Tuesday 3 November");
  });

  it("formats an item's date and an activity time", () => {
    expect(formatTodayDate("2026-10-17T07:41:00Z")).toBe("17 Oct 2026");
    expect(formatActivityTime("2026-10-19T07:41:00Z")).toBe("19 Oct, 09:41");
  });
});

describe("describeTileWaiting", () => {
  it("says Nothing waiting at zero", () => {
    expect(describeTileWaiting(0, null)).toBe("Nothing waiting");
  });

  it("names the oldest item's date otherwise", () => {
    expect(describeTileWaiting(2, "2026-10-17T07:41:00Z")).toBe("Oldest: 17 Oct 2026");
  });
});

describe("buildTodoItems", () => {
  const reports: TodayReport[] = [
    {
      id: "rep-new",
      created_at: "2026-10-18T10:00:00Z",
      reason: "Copyright infringement",
      bookTitle: "Kënga e fundit",
    },
    { id: "rep-old", created_at: "2026-10-10T10:00:00Z", reason: "Other", bookTitle: null },
  ];
  const refunds: TodayRefund[] = [
    { id: "ref-mid", requested_at: "2026-10-12T10:00:00+00:00", readerName: "Arta" },
  ];

  const now = new Date("2026-10-20T10:00:00Z");

  it("merges reports and refunds, oldest first, each linking to its detail page", () => {
    const items = buildTodoItems(reports, refunds, TODO_LIMIT, now);
    expect(items.map((i) => i.href)).toEqual([
      "/admin/reports/rep-old",
      "/admin/refunds/ref-mid",
      "/admin/reports/rep-new",
    ]);
    expect(items[0]).toMatchObject({
      title: "Other report on “Book unavailable”, 10 days ago",
      detail: "Reported 10 Oct 2026",
      actionLabel: "Review report",
    });
    expect(items[1]).toMatchObject({
      title: "Refund request from Arta",
      detail: "Requested 12 Oct 2026",
      actionLabel: "Review request",
    });
    // ADMIN-2-TAKEDOWN (E): `<Reason> report on “<Title>”, <relative time>`.
    expect(items[2].title).toBe("Copyright report on “Kënga e fundit”, 2 days ago");
  });

  it("shows at most five rows", () => {
    expect(TODO_LIMIT).toBe(5);
    const many: TodayReport[] = Array.from({ length: 8 }, (_, n) => ({
      id: `r${n}`,
      created_at: `2026-10-0${n + 1}T00:00:00Z`,
      reason: "Other",
      bookTitle: "B",
    }));
    const items = buildTodoItems(many, refunds);
    expect(items).toHaveLength(5);
    expect(items.map((i) => i.key)).toEqual(["report-r0", "report-r1", "report-r2", "report-r3", "report-r4"]);
  });

  it("is empty when nothing waits", () => {
    expect(buildTodoItems([], [])).toEqual([]);
  });

  it("never carries an amount", () => {
    for (const item of buildTodoItems(reports, refunds)) {
      expect(`${item.title} ${item.detail}`).not.toMatch(/ALL|€|\$|amount/i);
    }
  });
});

// ADMIN-2-TAKEDOWN (E, S7): the To do row's reason and relative time.
describe("shortReportReason", () => {
  it("shortens the readers' report reasons", () => {
    expect(shortReportReason("Copyright infringement")).toBe("Copyright");
    expect(shortReportReason("Inappropriate or offensive content")).toBe("Content");
    expect(shortReportReason("Spam or misleading listing")).toBe("Spam");
    expect(shortReportReason("Other")).toBe("Other");
  });

  it("shows an unknown legacy value as is, and a missing one as Other", () => {
    expect(shortReportReason("Wrong cover")).toBe("Wrong cover");
    expect(shortReportReason(null)).toBe("Other");
  });
});

describe("formatRelativeTime", () => {
  const now = new Date("2026-10-19T12:00:00Z");

  it("reads just now under a minute, and for a time in the future", () => {
    expect(formatRelativeTime("2026-10-19T11:59:30Z", now)).toBe("just now");
    expect(formatRelativeTime("2026-10-19T12:05:00Z", now)).toBe("just now");
  });

  it("counts minutes under an hour and hours under a day", () => {
    expect(formatRelativeTime("2026-10-19T11:55:00Z", now)).toBe("5 minutes ago");
    expect(formatRelativeTime("2026-10-19T09:00:00Z", now)).toBe("3 hours ago");
  });

  it("counts calendar days on Albanian time after a day", () => {
    expect(formatRelativeTime("2026-10-18T10:00:00Z", now)).toBe("yesterday");
    expect(formatRelativeTime("2026-10-17T10:00:00Z", now)).toBe("2 days ago");
    // 23:30 UTC on the 16th is already the 17th in Tirane (UTC+2).
    expect(formatRelativeTime("2026-10-16T23:30:00Z", now)).toBe("2 days ago");
  });
});
