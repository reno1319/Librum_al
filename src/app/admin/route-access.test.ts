import { describe, expect, it } from "vitest";
import { decideStaffAccess } from "@/lib/staff";
import type { StaffRole } from "@/lib/types";

// ADMIN-1A pre-finalize correction: focused tests proving the exact
// named scenarios the correction asked for, expressed directly against
// each admin route's own real permission requirement -- reports.view for
// /admin/reports and /admin/reports/[id] (src/app/admin/reports/page.tsx,
// src/app/admin/reports/[id]/page.tsx), refunds.view for /admin/refunds
// (src/app/admin/refunds/page.tsx), and admin.access for the shared
// /admin/* layout (src/app/admin/layout.tsx). Deliberately composes
// decideStaffAccess() (already exhaustively tested against every
// role/permission pair by src/lib/staff-permissions.test.ts and
// src/lib/staff.test.ts) rather than re-deriving that matrix here -- this
// file's own job is only to tie specific roles to specific ROUTES, which
// the matrix tests alone don't express.
function allow(role: StaffRole, permission: Parameters<typeof decideStaffAccess>[0]["permission"]) {
  return decideStaffAccess({ userId: "staff-1", staffRole: role, permission }).kind === "allow";
}

describe("admin route access, by role", () => {
  it("moderator can access reports but not refunds", () => {
    expect(allow("moderator", "reports.view")).toBe(true);
    expect(allow("moderator", "refunds.view")).toBe(false);
  });

  it("support can access refunds but not reports", () => {
    expect(allow("support", "refunds.view")).toBe(true);
    expect(allow("support", "reports.view")).toBe(false);
  });

  it("admin can access both reports and refunds", () => {
    expect(allow("admin", "reports.view")).toBe(true);
    expect(allow("admin", "refunds.view")).toBe(true);
  });

  it("owner can access both reports and refunds", () => {
    expect(allow("owner", "reports.view")).toBe(true);
    expect(allow("owner", "refunds.view")).toBe(true);
  });

  it("editor cannot enter /admin at all", () => {
    expect(allow("editor", "admin.access")).toBe(false);
    // Consequently editor can reach neither sub-route either, though the
    // layout gate is what actually stops them before either page's own
    // check would even run.
    expect(allow("editor", "reports.view")).toBe(false);
    expect(allow("editor", "refunds.view")).toBe(false);
  });

  it("every role that can enter /admin holds at least one of reports.view/refunds.view", () => {
    const staffRoles: StaffRole[] = ["owner", "admin", "moderator", "support"];
    for (const role of staffRoles) {
      expect(allow(role, "admin.access")).toBe(true);
      expect(allow(role, "reports.view") || allow(role, "refunds.view")).toBe(true);
    }
  });
});
