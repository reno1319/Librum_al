import Link from "next/link";
import { requireStaff } from "@/lib/staff";
import { roleHasPermission } from "@/lib/staff-permissions";
import { createClient } from "@/lib/supabase/server";
import { resolveAdminLandingVisibility } from "../admin-landing-logic";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Admin",
};

// Minimal admin landing page for Phase REFUND-1A -- proves
// requireStaff() actually gates this route (unauthenticated -> /login,
// authenticated non-staff -> /, staff with admin.access -> this page
// renders) before any real admin functionality (refund review,
// moderation, etc.) is built on top of it. Now links out to the first
// such feature (Phase REFUND-1B Step 3's refund review queue) rather
// than staying a dead end.
//
// ADMIN-1A: migrated from requireAdmin() to requireStaff("admin.access").
// requireStaff() deliberately returns only { userId, role }, not a full
// profile row -- it's a lean, reusable authorization primitive, not a
// data-fetching one, since most callers (every Server Action in this
// file's siblings) never need display_name at all. This one small extra
// query is this page's own business, not requireStaff()'s.
export default async function AdminPage() {
  const { userId, role } = await requireStaff("admin.access");

  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", userId)
    .single();

  // ADMIN-1A final pre-commit correction: derived from the role
  // requireStaff() already returned above, via the same pure
  // roleHasPermission() the SQL-side staff_has_permission() is kept in
  // sync with (src/lib/staff-permissions.ts) -- no separate
  // hasPermission() calls, which would each redo an auth.getUser() +
  // staff_members read requireStaff() already just did. admin.access
  // alone does not imply either of these -- 'moderator' has admin.access
  // + reports.view but not refunds.view; 'support' has admin.access +
  // refunds.view but not reports.view. Each link's visibility mirrors
  // exactly the permission its destination route now itself enforces
  // (src/app/admin/reports/page.tsx requires reports.view;
  // src/app/admin/refunds/page.tsx requires refunds.view) -- a staff
  // member is never shown a link that would immediately redirect them
  // away.
  const { showReports, showRefunds, showBlog } = resolveAdminLandingVisibility({
    reportsView: roleHasPermission(role, "reports.view"),
    refundsView: roleHasPermission(role, "refunds.view"),
    blogView: roleHasPermission(role, "blog.view"),
  });

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10 sm:px-6">
      <h1 className="font-serif text-3xl font-semibold">Admin</h1>
      <p className="mt-1 text-sm text-muted">Librum administration</p>
      <p className="mt-6 text-sm text-foreground/90">
        Signed in as {profile?.display_name ?? "staff member"}.
      </p>

      {showReports || showRefunds || showBlog ? (
        // MOBILE ADMIN SHELL CORRECTION: stacked by default (a narrow
        // phone width squeezed these two side-by-side), back to the
        // original flex-row + wrap layout from `sm:` up -- unchanged at
        // every width this already rendered correctly at.
        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
          {showRefunds && (
            <Link
              href="/admin/refunds"
              className="w-full rounded-lg border border-border bg-surface px-4 py-2 text-center text-sm font-medium hover:bg-surface-hover sm:w-auto sm:text-left"
            >
              Refund requests
            </Link>
          )}
          {showReports && (
            <Link
              href="/admin/reports"
              className="w-full rounded-lg border border-border bg-surface px-4 py-2 text-center text-sm font-medium hover:bg-surface-hover sm:w-auto sm:text-left"
            >
              Book reports
            </Link>
          )}
          {/* BLOG-1C: editor's first real admin destination -- fixes the
              "no admin tools" fallback this page used to show it before
              /admin/blog existed (BLOG-1B deliberately deferred this). */}
          {showBlog && (
            <Link
              href="/admin/blog"
              className="w-full rounded-lg border border-border bg-surface px-4 py-2 text-center text-sm font-medium hover:bg-surface-hover sm:w-auto sm:text-left"
            >
              Blog
            </Link>
          )}
        </div>
      ) : (
        <p className="mt-6 text-sm text-muted">
          Your staff role doesn&apos;t currently grant access to any admin tools here.
        </p>
      )}
    </main>
  );
}
