import { describe, expect, it } from "vitest";
import { ADMIN_NAV_ITEMS, resolveVisibleAdminNavItems } from "./admin-nav";
import type { StaffRole } from "@/lib/types";

// ADMIN-1A.5 "CURRENT ROLE EXPECTATIONS" -- exercised by name, against
// the actual nav config, not a re-derivation of the permission matrix
// itself (already exhaustively covered by
// src/lib/staff-permissions.test.ts).
describe("resolveVisibleAdminNavItems", () => {
  it("owner sees dashboard, reports, and refunds", () => {
    const hrefs = resolveVisibleAdminNavItems("owner").map((i) => i.href);
    expect(hrefs).toEqual(["/admin", "/admin/reports", "/admin/refunds"]);
  });

  it("admin sees dashboard, reports, and refunds", () => {
    const hrefs = resolveVisibleAdminNavItems("admin").map((i) => i.href);
    expect(hrefs).toEqual(["/admin", "/admin/reports", "/admin/refunds"]);
  });

  it("moderator sees dashboard and reports only -- not refunds", () => {
    const hrefs = resolveVisibleAdminNavItems("moderator").map((i) => i.href);
    expect(hrefs).toEqual(["/admin", "/admin/reports"]);
  });

  it("support sees dashboard and refunds only -- not reports", () => {
    const hrefs = resolveVisibleAdminNavItems("support").map((i) => i.href);
    expect(hrefs).toEqual(["/admin", "/admin/refunds"]);
  });

  it("editor sees nothing -- editor currently lacks admin.access entirely", () => {
    expect(resolveVisibleAdminNavItems("editor")).toEqual([]);
  });

  it("never includes a Staff/Audit entry -- no such UI exists yet", () => {
    const labels = ADMIN_NAV_ITEMS.map((i) => i.label.toLowerCase());
    expect(labels.some((l) => l.includes("staff"))).toBe(false);
    expect(labels.some((l) => l.includes("audit"))).toBe(false);
  });

  it("every nav item's permission matches its own destination route's real requireStaff() gate", () => {
    // Cross-check against this codebase's own known route->permission
    // wiring (src/app/admin/layout.tsx, reports/page.tsx,
    // refunds/page.tsx) -- a mismatch here would mean the nav shows a
    // link that its own destination would immediately redirect away
    // from, or hides one a role could actually use.
    const expected: Record<string, string> = {
      "/admin": "admin.access",
      "/admin/reports": "reports.view",
      "/admin/refunds": "refunds.view",
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
