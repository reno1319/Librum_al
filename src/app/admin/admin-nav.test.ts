import { describe, expect, it } from "vitest";
import { ADMIN_NAV_ITEMS, resolveVisibleAdminNavItems } from "./admin-nav";
import type { StaffRole } from "@/lib/types";

// ADMIN-1A.5 "CURRENT ROLE EXPECTATIONS" -- exercised by name, against
// the actual nav config, not a re-derivation of the permission matrix
// itself (already exhaustively covered by
// src/lib/staff-permissions.test.ts). ADMIN-1B PART C extended this for
// the Staff entry (staff.view-gated); ADMIN-1C PART C extends it again
// for the new Audit log entry (audit.view-gated), without touching the
// existing Dashboard/Book reports/Refund requests/Staff expectations.
describe("resolveVisibleAdminNavItems", () => {
  it("owner sees dashboard, reports, refunds, staff, audit log, and finance", () => {
    const hrefs = resolveVisibleAdminNavItems("owner").map((i) => i.href);
    expect(hrefs).toEqual([
      "/admin",
      "/admin/reports",
      "/admin/refunds",
      "/admin/staff",
      "/admin/audit",
      "/admin/finance",
    ]);
  });

  it("admin sees dashboard, reports, refunds, staff, audit log, and finance", () => {
    const hrefs = resolveVisibleAdminNavItems("admin").map((i) => i.href);
    expect(hrefs).toEqual([
      "/admin",
      "/admin/reports",
      "/admin/refunds",
      "/admin/staff",
      "/admin/audit",
      "/admin/finance",
    ]);
  });

  it("moderator sees dashboard and reports only -- not refunds, staff, audit log, or finance", () => {
    const hrefs = resolveVisibleAdminNavItems("moderator").map((i) => i.href);
    expect(hrefs).toEqual(["/admin", "/admin/reports"]);
  });

  it("support sees dashboard and refunds only -- not reports, staff, audit log, or finance", () => {
    const hrefs = resolveVisibleAdminNavItems("support").map((i) => i.href);
    expect(hrefs).toEqual(["/admin", "/admin/refunds"]);
  });

  it("editor sees nothing -- editor currently lacks admin.access entirely", () => {
    expect(resolveVisibleAdminNavItems("editor")).toEqual([]);
  });

  it("includes a Staff entry, an Audit log entry, and a Finance entry", () => {
    const labels = ADMIN_NAV_ITEMS.map((i) => i.label.toLowerCase());
    expect(labels).toContain("staff");
    expect(labels).toContain("audit log");
    expect(labels).toContain("finance");
  });

  it("the Staff entry is gated by staff.view, not a role-name check", () => {
    const staffItem = ADMIN_NAV_ITEMS.find((i) => i.href === "/admin/staff");
    expect(staffItem?.permission).toBe("staff.view");
  });

  it("the Audit log entry is gated by audit.view, not a role-name check", () => {
    const auditItem = ADMIN_NAV_ITEMS.find((i) => i.href === "/admin/audit");
    expect(auditItem?.permission).toBe("audit.view");
  });

  it("the Finance entry is gated by finance.view, not a role-name check", () => {
    const financeItem = ADMIN_NAV_ITEMS.find((i) => i.href === "/admin/finance");
    expect(financeItem?.permission).toBe("finance.view");
  });

  it("every nav item's permission matches its own destination route's real requireStaff() gate", () => {
    // Cross-check against this codebase's own known route->permission
    // wiring (src/app/admin/(protected)/layout.tsx, reports/page.tsx,
    // refunds/page.tsx, staff/page.tsx, audit/page.tsx, finance/page.tsx)
    // -- a mismatch here would mean the nav shows a link that its own
    // destination would immediately redirect away from, or hides one a
    // role could actually use.
    const expected: Record<string, string> = {
      "/admin": "admin.access",
      "/admin/reports": "reports.view",
      "/admin/refunds": "refunds.view",
      "/admin/staff": "staff.view",
      "/admin/audit": "audit.view",
      "/admin/finance": "finance.view",
    };
    for (const item of ADMIN_NAV_ITEMS) {
      expect(item.permission).toBe(expected[item.href]);
    }
  });

  it("all five roles produce results consistent with the ADMIN-1A matrix (no crash, no undefined role)", () => {
    const roles: StaffRole[] = ["owner", "admin", "editor", "moderator", "support"];
    for (const role of roles) {
      expect(() => resolveVisibleAdminNavItems(role)).not.toThrow();
    }
  });
});
