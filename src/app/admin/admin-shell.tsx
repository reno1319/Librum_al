import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/(public)/auth/actions";
import { IconShield } from "@/components/icons";
import { NavLinks } from "@/components/nav-links";
import { resolveVisibleAdminNavItems } from "./admin-nav";
import { AdminMobileNav } from "./admin-mobile-nav";
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
// identity + sign out), a sidebar on desktop, a compact drawer on mobile
// (src/app/admin/admin-mobile-nav.tsx) -- nothing else.
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

  const navItems = resolveVisibleAdminNavItems(role);

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-surface px-4 py-4 sm:px-6">
        <Link
          href="/admin"
          className="focus-ring flex items-center gap-2 rounded-sm font-serif text-lg font-semibold text-primary"
        >
          <IconShield className="size-5" aria-hidden="true" />
          Librum Administration
        </Link>

        <div className="flex items-center gap-4">
          <div className="hidden text-right text-sm sm:block">
            <p className="font-medium text-foreground">
              {profile?.display_name ?? "Staff member"}
            </p>
            <p className="text-xs text-muted">{ROLE_LABELS[role]}</p>
          </div>

          <form action={logout} className="hidden md:block">
            <button
              type="submit"
              className="focus-ring rounded-sm text-sm font-medium text-foreground transition-colors hover:underline"
            >
              Sign out
            </button>
          </form>

          <AdminMobileNav items={navItems} logoutAction={logout} />
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row">
        <nav
          aria-label="Admin"
          className="hidden w-56 shrink-0 border-r border-border bg-surface px-4 py-6 md:block"
        >
          <ul className="flex flex-col gap-1">
            {navItems.map((item) => (
              <li key={item.href}>
                <NavLinks
                  items={[item]}
                  className="block rounded-md px-3 py-2 hover:bg-surface-hover"
                />
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
