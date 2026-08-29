import { describe, expect, it } from "vitest";
import { ADMIN_NAV_ITEMS, resolveVisibleAdminNavItems } from "./admin-nav";
import type { StaffRole } from "@/lib/types";

// ADMIN-1A.5 "CURRENT ROLE EXPECTATIONS" -- exercised by name, against
// the actual nav config, not a re-derivation of the permission matrix
// itself (already exhaustively covered by
// src/lib/staff-permissions.test.ts). ADMIN-1B PART C extends this for
// the new Staff entry (staff.view-gated) without touching the existing
// Dashboard/Book reports/Refund requests expectations.
describe("resolveVisibleAdminNavItems", () => {
  it("owner sees dashboard, reports, refunds, and staff", () => {
    const hrefs = resolveVisibleAdminNavItems("owner").map((i) => i.href);
    expect(hrefs).toEqual(["/admin", "/admin/reports", "/admin/refunds", "/admin/staff"]);
  });

  it("admin sees dashboard, reports, refunds, and staff", () => {
    const hrefs = resolveVisibleAdminNavItems("admin").map((i) => i.href);
    expect(hrefs).toEqual(["/admin", "/admin/reports", "/admin/refunds", "/admin/staff"]);
  });

  it("moderator sees dashboard and reports only -- not refunds, not staff", () => {
    const hrefs = resolveVisibleAdminNavItems("moderator").map((i) => i.href);
    expect(hrefs).toEqual(["/admin", "/admin/reports"]);
  });

  it("support sees dashboard and refunds only -- not reports, not staff", () => {
    const hrefs = resolveVisibleAdminNavItems("support").map((i) => i.href);
    expect(hrefs).toEqual(["/admin", "/admin/refunds"]);
  });

  it("editor sees nothing -- editor currently lacks admin.access entirely", () => {
    expect(resolveVisibleAdminNavItems("editor")).toEqual([]);
  });

  it("includes a Staff entry, but never an Audit entry -- no audit UI exists yet", () => {
    const labels = ADMIN_NAV_ITEMS.map((i) => i.label.toLowerCase());
    expect(labels).toContain("staff");
    expect(labels.some((l) => l.includes("audit"))).toBe(false);
  });

  it("the Staff entry is gated by staff.view, not a role-name check", () => {
    const staffItem = ADMIN_NAV_ITEMS.find((i) => i.href === "/admin/staff");
    expect(staffItem?.permission).toBe("staff.view");
  });

  it("every nav item's permission matches its own destination route's real requireStaff() gate", () => {
    // Cross-check against this codebase's own known route->permission
    // wiring (src/app/admin/(protected)/layout.tsx, reports/page.tsx,
    // refunds/page.tsx, staff/page.tsx) -- a mismatch here would mean the
    // nav shows a link that its own destination would immediately
    // redirect away from, or hides one a role could actually use.
    const expected: Record<string, string> = {
      "/admin": "admin.access",
      "/admin/reports": "reports.view",
      "/admin/refunds": "refunds.view",
      "/admin/staff": "staff.view",
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
