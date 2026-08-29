import { cookies } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/(public)/auth/actions";
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
//
// LIBRUM 2.0 UI-3 visual refinement pass: the header's own publishing
// CTA (UI-2's `cta` field) was removed entirely -- the global header is
// navigation/account-only now. The homepage owns its own auth-aware
// publishing CTA independently (src/lib/homepage.ts's
// resolveHomepageCta()), which was always a separate decision boundary
// from this one, so removing this field doesn't touch that logic at
// all. No dead field left behind: SiteHeaderNavState has no `cta`
// member any more, not merely an unused one.
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
  // LIBRUM 2.0 GLOBAL VISUAL POLISH 1: reordered to Home / About / How
  // it works / Earnings / Bookstore -- Bookstore moved to last since the
  // public nav otherwise reads author-first (matching the homepage's own
  // author-acquisition purpose), with the reader-facing marketplace link
  // still present but no longer leading. Routes/labels unchanged.
  const primaryLinks: NavItem[] = [
    { href: "/", label: "Home" },
    { href: "/about", label: "About" },
    { href: "/how-it-works", label: "How it works" },
    { href: "/pricing", label: "Earnings" },
    { href: "/bookstore", label: "Bookstore" },
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
    <header className="relative flex flex-wrap items-center justify-between gap-4 border-b border-border bg-surface px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center gap-8">
        <Link
          href="/"
          className="focus-ring rounded-sm font-serif text-xl font-semibold text-primary"
        >
          Librum
        </Link>

        <nav className="hidden items-center gap-6 text-sm font-medium md:flex">
          <NavLinks items={nav.primaryLinks} />
        </nav>
      </div>

      <div className="flex items-center gap-3">
        <nav className="hidden items-center gap-6 text-sm md:flex">
          {nav.recoveryLabel && (
            <span className="text-muted">{nav.recoveryLabel}</span>
          )}
          {nav.showDisplayName && displayName && (
            <span className="text-muted">{displayName}</span>
          )}
          {/* LIBRUM 2.0 UI-3 final polish: logged-out desktop gets an
              explicit "Log in" text link rather than relying solely on
              the person icon below -- purely a presentational split by
              breakpoint, so it's driven directly off `user` here rather
              than adding a field to buildSiteHeaderNav()'s state. `user`
              being falsy already rules out recovery (a recovery session
              always has a real Supabase user), so no separate
              recoveryActive check is needed. */}
          {!user && (
            <Link
              href={nav.accountHref}
              className="focus-ring rounded-sm text-foreground transition-colors hover:underline"
            >
              Log in
            </Link>
          )}
          {nav.showLogout && (
            <form action={logout}>
              <button
                type="submit"
                className="focus-ring rounded-sm text-foreground transition-colors hover:underline"
              >
                Log out
              </button>
            </form>
          )}
        </nav>

        {nav.showAccountLink && (
          <Link
            href={nav.accountHref}
            aria-label={nav.accountLabel}
            className={`focus-ring flex size-11 items-center justify-center rounded-sm text-foreground ${!user ? "md:hidden" : ""}`}
          >
            <span aria-hidden="true">
              <IconPerson className="size-5" />
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
