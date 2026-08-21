import { requireAdmin } from "@/lib/auth";

// Gates every /admin/* route centrally, same pattern as
// src/app/dashboard/layout.tsx for author-only routes -- added now that
// /admin is growing beyond the single landing page it started as
// (src/app/admin/page.tsx still calls requireAdmin() itself too; that's
// harmless redundancy left as-is rather than touched here, since it
// already shipped and was security-reviewed in Phase REFUND-1A).
export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireAdmin();

  return <>{children}</>;
}
