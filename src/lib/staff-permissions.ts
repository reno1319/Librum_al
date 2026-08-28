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
// - editor: no permissions at all, yet. There is no internal editorial
//   admin surface in this codebase today, current or imminent -- granting
//   admin.access "because the role exists" would be exactly the
//   meaningless access the design brief warns against. The role is
//   persisted so it's available the moment a real editorial surface is
//   built, without a schema change.
export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly Permission[]>> = {
  owner: [
    "admin.access",
    "reports.view",
    "reports.resolve",
    "refunds.view",
    "refunds.resolve",
    "staff.view",
    "staff.manage",
  ],
  admin: [
    "admin.access",
    "reports.view",
    "reports.resolve",
    "refunds.view",
    "refunds.resolve",
    "staff.view",
  ],
  moderator: ["admin.access", "reports.view", "reports.resolve"],
  support: ["admin.access", "refunds.view"],
  editor: [],
};

export function roleHasPermission(role: StaffRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
