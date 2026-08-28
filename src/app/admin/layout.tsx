import { requireStaff } from "@/lib/staff";

// Gates every /admin/* route centrally, same pattern as
// src/app/dashboard/layout.tsx for author-only routes -- added now that
// /admin is growing beyond the single landing page it started as
// (src/app/admin/page.tsx still calls requireStaff() itself too; that's
// harmless redundancy left as-is rather than touched here, since it
// already shipped and was security-reviewed in Phase REFUND-1A).
// ADMIN-1A: migrated from requireAdmin() to requireStaff("admin.access")
// -- every staff role in the current matrix carries admin.access except
// 'editor' (which has no admin surface yet), so this is the correct,
// least-restrictive gate for "may see /admin at all," with each
// individual admin feature narrowing further on its own permission.
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireStaff("admin.access");

  return <>{children}</>;
}
