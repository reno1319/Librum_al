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
//
// BLOG-1C: showBlog added, gated by blog.view -- the same permission
// /admin/blog itself requires. BLOG-1B deliberately deferred adding
// this (no /admin/blog route existed yet, so a visible link would have
// been broken); it's added now that the route is real. This is what
// stops editor from seeing the "your staff role doesn't currently grant
// access to any admin tools here" fallback in page.tsx below -- editor
// holds blog.view (migration 047/staff-permissions.ts) but neither
// reportsView nor refundsView, so without this field editor would still
// see that misleading fallback despite having a real destination.
export function resolveAdminLandingVisibility(permissions: {
  reportsView: boolean;
  refundsView: boolean;
  blogView: boolean;
}): { showReports: boolean; showRefunds: boolean; showBlog: boolean } {
  return {
    showReports: permissions.reportsView,
    showRefunds: permissions.refundsView,
    showBlog: permissions.blogView,
  };
}
