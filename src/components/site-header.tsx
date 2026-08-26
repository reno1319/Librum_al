import { cookies } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/auth/actions";
import { isRecoverySessionActive } from "@/lib/recovery-session";
import { IconPerson } from "@/components/icons";
import { NavLinks, type NavItem } from "@/components/nav-links";
import { MobileNav } from "@/components/mobile-nav";
import { buttonClasses } from "@/components/ui/button";

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
export type HeaderCta = { label: string; href: string } | null;

export type SiteHeaderNavState = {
  primaryLinks: NavItem[];
  showDisplayName: boolean;
  showAccountLink: boolean;
  showLogout: boolean;
  recoveryLabel: string | null;
  accountHref: string;
  accountLabel: string;
  // LIBRUM 2.0 UI-2: additive field -- every existing field above is
  // unchanged in meaning/shape. null for both the reader state (no
  // role-conversion feature exists anywhere in this app, so a
  // "publish" CTA would be misleading -- see the UI-2 audit) and the
  // recovery state (no CTA of any kind during recovery, matching every
  // other suppressed affordance there).
  cta: HeaderCta;
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
      cta: null,
    };
  }

  // Role-correct label — never "Library" for an author, never "Dashboard"
  // for a reader. Authors can still browse/buy books via Bookstore above;
  // this is just their management-area link.
  const primaryLinks: NavItem[] = [
    { href: "/", label: "Home" },
    { href: "/bookstore", label: "Bookstore" },
    { href: "/how-it-works", label: "How it works" },
    { href: "/pricing", label: "Earnings" },
    { href: "/about", label: "About" },
  ];
  if (user) {
    primaryLinks.push(
      role === "author"
        ? { href: "/dashboard", label: "Dashboard" }
        : { href: "/library", label: "Library" },
    );
  }

  // LIBRUM 2.0 UI-2: the same "Publish your book" -> /signup?role=author
  // destination already proven on the homepage (src/app/page.tsx) --
  // reused here, not invented. Authors get the equivalent real
  // destination (the actual create-book flow). Readers get no CTA at
  // all: there is no account-role-conversion feature anywhere in this
  // app, so a "publish" affordance would promise something the product
  // can't deliver -- see the UI-2 audit's own reasoning.
  let cta: HeaderCta = null;
  if (!user) {
    cta = { label: "Publish your book", href: "/signup?role=author" };
  } else if (role === "author") {
    cta = { label: "New book", href: "/dashboard/books/new" };
  }

  return {
    primaryLinks,
    showDisplayName: !!user && !!displayName,
    showAccountLink: true,
    showLogout: !!user,
    recoveryLabel: null,
    accountHref,
    accountLabel,
    cta,
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

        {nav.cta && (
          <Link
            href={nav.cta.href}
            className={buttonClasses("primary", "sm", "hidden md:inline-flex")}
          >
            {nav.cta.label}
          </Link>
        )}

        {nav.showAccountLink && (
          <Link
            href={nav.accountHref}
            aria-label={nav.accountLabel}
            className="focus-ring flex size-11 items-center justify-center rounded-sm text-foreground"
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
          cta={nav.cta}
        />
      </div>
    </header>
  );
}
