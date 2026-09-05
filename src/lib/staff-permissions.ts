import type { Permission, StaffRole } from "@/lib/types";

// The single canonical role->permission matrix for this application.
// Permissions are never persisted in the database (see migration 040's
// staff_members table) -- this map is the one source of truth for what
// each staff role can do. supabase/migrations/040_staff_rbac_foundation.sql's
// staff_has_permission() SQL function is a deliberately small, explicitly
// synchronized second copy of this same matrix, required because RLS
// policies and RPCs need this same decision made inside Postgres, not
// just in application code -- see that migration's own comment for the
// full reasoning, and staff-permissions.contract.test.ts (this file's own
// sibling test) plus supabase/tests/040_staff_rbac_foundation.test.sql for
// the two tests that keep both copies honest.
//
// Stress-tested per the ADMIN-1A design brief's own instruction (least
// privilege matters):
// - owner: every permission that exists, including staff.manage -- the
//   one role that can bootstrap and administer the staff roster itself.
// - admin: everything an 'owner' has EXCEPT staff.manage. staff.manage is
//   deliberately withheld even from 'admin' -- it is the single most
//   sensitive permission in this matrix (it can grant or change another
//   person's staff access), so it is scoped as narrowly as possible
//   rather than bundled in with the rest of "full admin capability."
// - moderator: exactly admin.access + reports.view + reports.resolve --
//   no refunds permission of any kind, and no staff visibility. A
//   moderator cannot see or resolve refund requests.
// - support: exactly admin.access + refunds.view -- no refunds.resolve
//   (support can see a refund request's context but cannot approve or
//   reject it), and no reports.view (support has no concrete, current
//   need to see the moderation queue -- not granted merely because it
//   exists; add it later with a real justification if that changes).
// - editor: BLOG-1B is the real editorial surface the paragraph above
//   used to say didn't exist yet -- it now grants exactly three
//   permissions: admin.access (the structural prerequisite to enter
//   /admin/(protected) at all -- src/app/admin/(protected)/layout.tsx
//   gates the whole tree on this before any page-specific permission is
//   ever checked, so blog.view/blog.manage alone would leave editor
//   redirected away before ever reaching /admin/blog), blog.view, and
//   blog.manage. Nothing else: editor still has no reports/refunds/
//   staff/audit/finance visibility of any kind -- admin.access carries
//   no capability of its own beyond "may enter the shell," so this is
//   not the "meaningless access" grant this comment used to warn
//   against, it's the minimum a real, now-existing surface needs.
//
// ADMIN-1D Part B adds finance.view, granted to owner and admin only --
// exactly the same two roles that already hold audit.view, refunds.view,
// and refunds.resolve. moderator/support get none of it: moderator's
// domain (content reports) has no financial relevance, support already
// sees refund requests via refunds.view but has never been granted
// refunds.resolve, so it gains no new financial capability or
// visibility here either. Explicitly NOT added here: finance.reconcile,
// finance.recover_orphaned, finance.export -- ADMIN-1D Part B is
// read-only primitives only; a mutation permission is added in the same
// change that adds the RPC it guards, in a later part, never
// speculatively ahead of one.
//
// BLOG-1B adds blog.view/blog.manage, granted to owner, admin, and
// editor -- see migration 047's own header for the full RPC-only
// mutation design these two permissions gate (blog_posts carries no
// direct table-level write grant to authenticated at all; every
// create/edit/publish/unpublish/delete goes through a SECURITY DEFINER
// RPC that re-checks blog.manage itself). moderator/support get
// neither -- editorial content is unrelated to either role's existing
// responsibilities (dispute/refund/report triage), so granting it would
// be scope creep, not a real current need.
export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly Permission[]>> = {
  owner: [
    "admin.access",
    "reports.view",
    "reports.resolve",
    "refunds.view",
    "refunds.resolve",
    "staff.view",
    "staff.manage",
    "audit.view",
    "finance.view",
    "blog.view",
    "blog.manage",
  ],
  admin: [
    "admin.access",
    "reports.view",
    "reports.resolve",
    "refunds.view",
    "refunds.resolve",
    "staff.view",
    "audit.view",
    "finance.view",
    "blog.view",
    "blog.manage",
  ],
  moderator: ["admin.access", "reports.view", "reports.resolve"],
  support: ["admin.access", "refunds.view"],
  editor: ["admin.access", "blog.view", "blog.manage"],
};

export function roleHasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
