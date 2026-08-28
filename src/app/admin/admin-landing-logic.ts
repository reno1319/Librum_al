// Pure mapping from a staff member's own permissions to which links the
// /admin landing page shows -- deliberately separated from page.tsx so
// "landing-page links match permissions" is directly unit-testable
// without a JSX render harness, same extraction technique used
// throughout this codebase's admin/authorization logic (decideStaffAccess,
// report-review-logic.ts, refund-review-logic.ts). Each visible link
// mirrors the exact permission its own destination route enforces
// (reports.view for /admin/reports, refunds.view for /admin/refunds) --
// never admin.access alone, since admin.access only proves "some staff
// member," not which specific surfaces they may enter.
export function resolveAdminLandingVisibility(permissions: {
  reportsView: boolean;
  refundsView: boolean;
}): { showReports: boolean; showRefunds: boolean } {
  return {
    showReports: permissions.reportsView,
    showRefunds: permissions.refundsView,
  };
}
