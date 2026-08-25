import { cookies } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/auth/actions";
import { isRecoverySessionActive } from "@/lib/recovery-session";
import { IconPerson } from "@/components/icons";
import { NavLinks, type NavItem } from "@/components/nav-links";
import { MobileNav } from "@/components/mobile-nav";

// LAUNCH-1 P2-5: the render-state decision, extracted as a pure function
// so it's directly unit-testable (src/components/site-header.test.ts)
// without needing to render this Server Component. recoveryActive takes
// precedence over everything else -- a P1-11 recovery-restricted
// session still has a real Supabase user (that's the whole reason
// containment is needed), but this header must never show ordinary
// authenticated nav for it. See the P2-5 audit for why every
// primaryLinks entry (not just the role-conditional one) is a dead end
// during recovery: RECOVERY_ALLOWED_PATHS only ever contains
// /reset-password, /auth/callback, and /login.
export type SiteHeaderNavState = {
  primaryLinks: NavItem[];
  showDisplayName: boolean;
  showAccountLink: boolean;
  showLogout: boolean;
  recoveryLabel: string | null;
  accountHref: string;
  accountLabel: string;
};

export function buildSiteHeaderNav(params: {
  user: { id: string } | null;
  displayName: string | null;
  role: string | null;
  recoveryActive: boolean;
}): SiteHeaderNavState {
  const { user, displayName, role, recoveryActive } = params;

  const accountHref = user ? "/account" : "/login";
  const accountLabel = user ? "Account" : "Log in or sign up";

  if (recoveryActive) {
    return {
      primaryLinks: [],
      showDisplayName: false,
      showAccountLink: false,
      showLogout: true,
      recoveryLabel: "Password recovery",
      accountHref,
      accountLabel,
    };
  }

  // Role-correct label — never "Library" for an author, never "Dashboard"
  // for a reader. Authors can still browse/buy books via Bookstore above;
  // this is just their management-area link.
  const primaryLinks: NavItem[] = [
    { href: "/", label: "Home" },
    { href: "/bookstore", label: "Bookstore" },
    { href: "/about", label: "About" },
    { href: "/pricing", label: "Pricing" },
  ];
  if (user) {
    primaryLinks.push(
      role === "author"
        ? { href: "/dashboard", label: "Dashboard" }
        : { href: "/library", label: "Library" },
    );
  }

  return {
    primaryLinks,
    showDisplayName: !!user && !!displayName,
    showAccountLink: true,
    showLogout: !!user,
    recoveryLabel: null,
    accountHref,
    accountLabel,
  };
}

export async function SiteHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  let displayName: string | null = null;
  let role: string | null = null;

  if (user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("display_name, role")
      .eq("id", user.id)
      .single();
    displayName = profile?.display_name ?? null;
    role = profile?.role ?? null;
  }

  const cookieStore = await cookies();
  const recoveryActive = isRecoverySessionActive(cookieStore);

  const nav = buildSiteHeaderNav({
    user: user ? { id: user.id } : null,
    displayName,
    role,
    recoveryActive,
  });

  return (
    <header
      className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-surface px-4 py-4 sm:px-6"
      style={{ position: "relative" }}
    >
      <div className="flex flex-wrap items-center" style={{ gap: "2rem" }}>
        <Link
          href="/"
          className="font-serif text-xl font-semibold text-primary"
        >
          Librum
        </Link>

        <nav
          className="hidden items-center gap-4 text-sm font-medium md:flex"
        >
          <NavLinks items={nav.primaryLinks} />
        </nav>
      </div>

      <div className="flex items-center gap-3">
        <nav className="hidden items-center gap-4 text-sm md:flex">
          {nav.recoveryLabel && (
            <span className="text-muted">{nav.recoveryLabel}</span>
          )}
          {nav.showDisplayName && displayName && (
            <span className="text-muted">{displayName}</span>
          )}
          {nav.showLogout && (
            <form action={logout}>
              <button type="submit" className="hover:underline">
                Log out
              </button>
            </form>
          )}
        </nav>

        {nav.showAccountLink && (
          <Link
            href={nav.accountHref}
            aria-label={nav.accountLabel}
            className="flex items-center justify-center text-foreground"
            style={{ width: "2.75rem", height: "2.75rem" }}
          >
            <span aria-hidden="true">
              <IconPerson style={{ width: "1.25rem", height: "1.25rem" }} />
            </span>
          </Link>
        )}

        <MobileNav
          items={nav.primaryLinks}
          loggedIn={!!user}
          accountHref={nav.accountHref}
          logoutAction={logout}
          recoveryActive={recoveryActive}
        />
      </div>
    </header>
  );
}
