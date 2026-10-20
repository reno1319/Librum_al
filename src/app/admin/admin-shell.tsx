import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/(public)/auth/actions";
import { resolveVisibleAdminNavGroups } from "./admin-nav";
import { AdminMobileNav } from "./admin-mobile-nav";
import { AdminSidebarNav } from "./admin-sidebar-nav";
import type { StaffRole } from "@/lib/types";

// Informational only -- see the module comment below.
const ROLE_LABELS: Record<StaffRole, string> = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  moderator: "Moderator",
  support: "Support",
};

// ADMIN-1A.5: the reusable back-office shell for every protected
// /admin/* page. FINAL ROUTING INVARIANT CORRECTION: which pages get
// wrapped in this shell is now decided structurally, by directory --
// admin/(protected)/layout.tsx renders this for everything nested inside
// admin/(protected)/ (page.tsx, reports/**, refunds/**), and nothing
// else does. admin/login/page.tsx is a sibling of admin/(protected)/,
// not a child of it, so it never reaches this component at all -- there
// is no pathname check anywhere deciding "except /admin/login" any more.
// Restrained by design, per the brief's own "do not overbuild an
// enterprise dashboard" instruction: one header (branding + staff
// identity + sign out), a sidebar on desktop, a compact "Section" menu
// on mobile (src/app/admin/admin-mobile-nav.tsx) -- nothing else.
//
// role/userId are passed in from admin/(protected)/layout.tsx's own
// requireStaff() call (the actual authorization boundary) -- this
// component does no authorization of its own; it only reads role to
// decide what to SHOW.
// display_name is fetched here, not by the caller, the same "each layer
// fetches only the data it itself needs to render" pattern
// src/app/admin/(protected)/page.tsx already established for the exact
// same lookup.
//
// Role display is informational only, per the design brief -- the
// permission checks that actually gate every admin surface never read
// anything rendered here or trust any browser-visible state; they all
// re-derive identity/role server-side via requireStaff()/
// getStaffMember() on every request, independent of this component.
//
// ADMIN-1 (A2 look): a dark green header ("Librum" in Caslon, a gold
// ADMINISTRATION eyebrow, name and role in gold, Log out), a white
// grouped sidebar from md up (admin-sidebar-nav.tsx), and on phones one
// "Section" control under the header in place of the ☰ drawer
// (admin-mobile-nav.tsx), which also holds Log out. Gold on the green
// header is the brass token (accent); brass is never text on cream.
export async function AdminShell({
  userId,
  role,
  children,
}: {
  userId: string;
  role: StaffRole;
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const { data: profile } = await supabase
    .from("profiles")
    .select("display_name")
    .eq("id", userId)
    .single();

  const navGroups = resolveVisibleAdminNavGroups(role);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between gap-4 bg-primary px-4 py-3.5 text-primary-foreground sm:px-8 md:py-4">
        <Link
          href="/admin"
          className="focus-ring flex items-baseline gap-2 rounded-sm text-primary-foreground md:gap-3"
        >
          <span className="font-serif text-[1.3125rem] font-bold md:text-2xl">Librum</span>
          <span className="text-[0.6875rem] font-semibold tracking-[0.14em] text-accent uppercase md:text-xs">
            <span className="md:hidden">Admin</span>
            <span className="hidden md:inline">Administration</span>
          </span>
        </Link>

        <div className="flex min-w-0 items-center gap-5 text-sm">
          <p className="min-w-0 truncate">
            {profile?.display_name ?? "Staff member"} ·{" "}
            <span className="text-accent">{ROLE_LABELS[role]}</span>
          </p>

          <form action={logout} className="hidden md:block">
            <button
              type="submit"
              className="focus-ring min-h-11 rounded-sm text-sm font-medium text-primary-foreground underline-offset-4 transition-colors hover:underline"
            >
              Log out
            </button>
          </form>
        </div>
      </header>

      <div className="px-4 pt-4 md:hidden">
        <AdminMobileNav groups={navGroups} logoutAction={logout} />
      </div>

      <div className="flex flex-1 flex-col md:flex-row">
        <div className="hidden w-60 shrink-0 border-r border-border bg-surface px-4 py-6 md:block">
          <AdminSidebarNav groups={navGroups} />
        </div>

        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
