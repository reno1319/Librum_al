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
// Deliberately does NOT include a Staff/Audit entry -- ADMIN-1A already
// defines staff.view/staff.manage permissions for future use, but no
// staff-directory or audit-log UI exists yet (explicitly out of scope
// for ADMIN-1A.5, deferred to ADMIN-1B/1C) -- an entry with no
// destination to navigate to would be a dead link, not a feature.
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  { href: "/admin", label: "Dashboard", permission: "admin.access" },
  { href: "/admin/reports", label: "Book reports", permission: "reports.view" },
  { href: "/admin/refunds", label: "Refund requests", permission: "refunds.view" },
];

// Pure visibility resolver -- every /admin/* role's nav is derived from
// this one function, driven entirely by roleHasPermission() (the same
// canonical TypeScript permission layer staff_has_permission() in SQL is
// kept in sync with), never by role identity directly.
export function resolveVisibleAdminNavItems(role: StaffRole): AdminNavItem[] {
  return ADMIN_NAV_ITEMS.filter((item) => roleHasPermission(role, item.permission));
}
