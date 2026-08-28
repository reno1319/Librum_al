import { describe, expect, it } from "vitest";
import { resolveAdminLandingVisibility } from "./admin-landing-logic";
import { roleHasPermission } from "@/lib/staff-permissions";
import type { StaffRole } from "@/lib/types";

// "landing-page links match those permissions" (ADMIN-1A pre-finalize
// correction, item 10) -- exercised per role, deriving each role's real
// reports.view/refunds.view from the canonical matrix (roleHasPermission)
// rather than hand-picking booleans, so this test would actually fail if
// the matrix and the landing page's visibility logic ever disagreed.
function visibilityFor(role: StaffRole) {
  return resolveAdminLandingVisibility({
    reportsView: roleHasPermission(role, "reports.view"),
    refundsView: roleHasPermission(role, "refunds.view"),
  });
}

describe("resolveAdminLandingVisibility", () => {
  it("owner sees both links", () => {
    expect(visibilityFor("owner")).toEqual({ showReports: true, showRefunds: true });
  });

  it("admin sees both links", () => {
    expect(visibilityFor("admin")).toEqual({ showReports: true, showRefunds: true });
  });

  it("moderator sees only Book reports", () => {
    expect(visibilityFor("moderator")).toEqual({ showReports: true, showRefunds: false });
  });

  it("support sees only Refund requests", () => {
    expect(visibilityFor("support")).toEqual({ showReports: false, showRefunds: true });
  });

  it("editor sees neither link (moot in practice -- editor cannot pass the /admin layout gate at all)", () => {
    expect(visibilityFor("editor")).toEqual({ showReports: false, showRefunds: false });
  });

  it("never shows a link the caller's own permission is false for, regardless of combination", () => {
    for (const reportsView of [true, false]) {
      for (const refundsView of [true, false]) {
        const visibility = resolveAdminLandingVisibility({ reportsView, refundsView });
        expect(visibility.showReports).toBe(reportsView);
        expect(visibility.showRefunds).toBe(refundsView);
      }
    }
  });
});
