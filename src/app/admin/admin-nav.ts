import { roleHasPermission } from "@/lib/staff-permissions";
import type { Permission, StaffRole } from "@/lib/types";

export type AdminNavItem = {
  href: string;
  label: string;
  permission: Permission;
};

// ADMIN-1A.5: the single source of truth for admin-shell navigation.
// Permission-driven, not role-name-driven -- each entry names the exact
// permission its own destination route enforces (mirrors
// src/app/admin/reports/page.tsx's requireStaff("reports.view"),
// src/app/admin/refunds/page.tsx's requireStaff("refunds.view"), and
// src/app/admin/layout.tsx's requireStaff("admin.access")), never a
// hardcoded role check like `if (role === "moderator")`. Adding a new
// admin surface later means adding one entry here with its real
// permission -- visibility then follows automatically from the existing
// role->permission matrix (src/lib/staff-permissions.ts), nothing else
// to update.
//
// ADMIN-1B PART C: Staff added, gated by staff.view (the same
// permission src/app/admin/(protected)/staff/page.tsx itself requires)
// -- a staff.view holder without staff.manage still gets the link, and
// the page renders in its own read-only mode for them, exactly like
// this codebase's every other permission-driven surface. Audit is
// deliberately still NOT added here -- no /admin/audit UI exists yet
// (ADMIN-1C's own scope) -- an entry with no destination would be a
// dead link, not a feature, same reasoning this file already applied
// to Staff before this pass.
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { href: "/admin", label: "Dashboard", permission: "admin.access" },
  { href: "/admin/reports", label: "Book reports", permission: "reports.view" },
  { href: "/admin/refunds", label: "Refund requests", permission: "refunds.view" },
  { href: "/admin/staff", label: "Staff", permission: "staff.view" },
];

// Pure visibility resolver -- every /admin/* role's nav is derived from
// this one function, driven entirely by roleHasPermission() (the same
// canonical TypeScript permission layer staff_has_permission() in SQL is
// kept in sync with), never by role identity directly.
export function resolveVisibleAdminNavItems(role: StaffRole): AdminNavItem[] {
  return ADMIN_NAV_ITEMS.filter((item) => roleHasPermission(role, item.permission));
}
