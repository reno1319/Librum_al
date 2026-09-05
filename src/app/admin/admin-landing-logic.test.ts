import { describe, expect, it } from "vitest";
import { resolveAdminLandingVisibility } from "./admin-landing-logic";
import { roleHasPermission } from "@/lib/staff-permissions";
import type { StaffRole } from "@/lib/types";

// "landing-page links match those permissions" (ADMIN-1A pre-finalize
// correction, item 10) -- exercised per role, deriving each role's real
// reports.view/refunds.view/blog.view from the canonical matrix
// (roleHasPermission) rather than hand-picking booleans, so this test
// would actually fail if the matrix and the landing page's visibility
// logic ever disagreed.
function visibilityFor(role: StaffRole) {
  return resolveAdminLandingVisibility({
    reportsView: roleHasPermission(role, "reports.view"),
    refundsView: roleHasPermission(role, "refunds.view"),
    blogView: roleHasPermission(role, "blog.view"),
  });
}

describe("resolveAdminLandingVisibility", () => {
  it("owner sees all three links", () => {
    expect(visibilityFor("owner")).toEqual({ showReports: true, showRefunds: true, showBlog: true });
  });

  it("admin sees all three links", () => {
    expect(visibilityFor("admin")).toEqual({ showReports: true, showRefunds: true, showBlog: true });
  });

  it("moderator sees only Book reports", () => {
    expect(visibilityFor("moderator")).toEqual({ showReports: true, showRefunds: false, showBlog: false });
  });

  it("support sees only Refund requests", () => {
    expect(visibilityFor("support")).toEqual({ showReports: false, showRefunds: true, showBlog: false });
  });

  it("editor sees only Blog -- BLOG-1C's own fix for the 'no admin tools' fallback", () => {
    expect(visibilityFor("editor")).toEqual({ showReports: false, showRefunds: false, showBlog: true });
  });

  it("never shows a link the caller's own permission is false for, regardless of combination", () => {
    for (const reportsView of [true, false]) {
      for (const refundsView of [true, false]) {
        for (const blogView of [true, false]) {
          const visibility = resolveAdminLandingVisibility({ reportsView, refundsView, blogView });
          expect(visibility.showReports).toBe(reportsView);
          expect(visibility.showRefunds).toBe(refundsView);
          expect(visibility.showBlog).toBe(blogView);
        }
      }
    }
  });
});
