import { requireStaff } from "@/lib/staff";
import { AdminShell } from "../admin-shell";

// ADMIN-1A.5 FINAL ROUTING INVARIANT CORRECTION: this is now the ONE
// place the staff gate lives, moved here from the outer admin/layout.tsx
// (see that file's own comment). Wraps every route under this group --
// currently admin/(protected)/page.tsx, reports/**, refunds/**, and
// not-found.tsx -- establishing the invariant the correction asked for:
// any page placed under admin/(protected)/ automatically inherits
// requireStaff("admin.access") and AdminShell, structurally, by virtue
// of where its file lives -- not by remembering to call anything. Same
// permission this always was (every staff role except 'editor' carries
// admin.access, matching src/lib/staff-permissions.ts's matrix); moving
// where it's enforced doesn't change who it allows in.
//
// admin/login/**, a sibling of admin/(protected)/ rather than a child of
// it, is structurally outside this boundary -- there is no code path by
// which requireStaff() runs for a request to /admin/login, so it cannot
// redirect back to itself. That is the "no redirect loop" proof for this
// correction: it is not a runtime check that could be wrong, it is a
// fact about which files exist under which directory.
//
// Individual pages under this group (admin/(protected)/reports/page.tsx
// requiring reports.view, refunds/page.tsx requiring refunds.view, the
// [id] detail pages requiring their own resolve permissions, and even
// page.tsx's own redundant requireStaff("admin.access") call) still call
// requireStaff() themselves too, same as before this correction -- this
// layout proves the coarse "may enter /admin at all" gate; it does not
// replace each surface's own finer-grained permission check.
export default async function ProtectedAdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId, role } = await requireStaff("admin.access");

  return (
    <AdminShell userId={userId} role={role}>
      {children}
    </AdminShell>
  );
}
