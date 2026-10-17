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
  // LIBRUM 2.0 BLOG-1D: Blog added directly after Bookstore, per the
  // BLOG-1 design report's own preferred ordering -- every other entry
  // and their relative order is unchanged.
  const primaryLinks: NavItem[] = [
    { href: "/", label: "Home" },
    { href: "/about", label: "About" },
    { href: "/how-it-works", label: "How it works" },
    { href: "/pricing", label: "Earnings" },
    { href: "/bookstore", label: "Bookstore" },
    { href: "/blog", label: "Blog" },
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

// REDESIGN STEP 2 (A2 "Library Green & Brass"): the header is a dark
// green bar with cream text. Brass is a fill only, with green text on it
// (5.85:1); cream on green is 11.1:1.
const OUTLINE_ON_DARK_CLASSES =
  "focus-ring inline-flex items-center rounded-[3px] border border-primary-foreground/40 px-4 py-2.5 font-semibold text-primary-foreground transition-colors hover:border-primary-foreground hover:bg-primary-hover";
// FIX1 (X12): "Log out" is a quiet cream text link, quieter than any
// button on the page; the outline button stays for "Log in" only.
const QUIET_LINK_ON_DARK_CLASSES =
  "focus-ring rounded-sm text-primary-foreground/85 underline underline-offset-4 transition-colors hover:text-primary-foreground hover:decoration-2";
const BRASS_BUTTON_CLASSES =
  "focus-ring inline-flex items-center rounded-[3px] bg-accent px-4 py-2.5 font-semibold text-accent-foreground transition-colors hover:bg-primary-foreground";

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
    <header className="relative bg-primary text-primary-foreground">
      {/* FIX1 (X12): one row from 1024px up -- no wrapping at lg, and
          tighter gaps there; the roomier gaps return at xl. */}
      <div className="mx-auto flex w-full max-w-wide flex-wrap items-center justify-between gap-x-8 gap-y-3 px-4 py-3 sm:px-6 lg:flex-nowrap lg:gap-x-6 xl:gap-x-8">
        <div className="flex min-w-0 flex-wrap items-center gap-x-8 gap-y-2 lg:flex-nowrap lg:gap-x-6 xl:gap-x-8">
          <Link
            href="/"
            className="focus-ring rounded-sm font-serif text-[1.75rem] font-bold text-primary-foreground"
          >
            Librum
          </Link>

          {/* Wraps onto a second row rather than scrolling sideways when
              the labels get longer (the Albanian translation runs about
              30% longer than this English copy). */}
          <nav className="hidden flex-wrap items-center gap-x-6 gap-y-2 text-base font-medium lg:flex lg:flex-nowrap lg:gap-x-4 lg:whitespace-nowrap xl:gap-x-6">
            <NavLinks items={nav.primaryLinks} onDark />
          </nav>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <nav className="hidden items-center gap-4 text-base lg:flex lg:whitespace-nowrap">
            {nav.recoveryLabel && (
              <span className="text-primary-foreground/80">{nav.recoveryLabel}</span>
            )}
            {/* FIX1 (X12): the name joins the row from 1280px, where it
                fits beside the links; a long one is cut with an ellipsis
                (its full text stays in the title tooltip). */}
            {nav.showDisplayName && displayName && (
              <span
                title={displayName}
                className="hidden max-w-[12rem] truncate text-primary-foreground/80 xl:inline"
              >
                {displayName}
              </span>
            )}
            {/* LIBRUM 2.0 UI-3 final polish: logged-out desktop gets an
                explicit "Log in" text link rather than relying solely on
                the person icon below -- purely a presentational split by
                breakpoint, so it's driven directly off `user` here rather
                than adding a field to buildSiteHeaderNav()'s state. `user`
                being falsy already rules out recovery (a recovery session
                always has a real Supabase user), so no separate
                recoveryActive check is needed.
                REDESIGN STEP 2: "Log in" is an outline button and "Sign
                up" (the label the mobile menu already uses for /signup) a
                brass one -- account actions, so the header stays
                navigation/account-only as UI-3 decided. */}
            {!user && (
              <>
                <Link href={nav.accountHref} className={OUTLINE_ON_DARK_CLASSES}>
                  Log in
                </Link>
                {/* FIX1 (X2): Author chosen, as on Earnings. */}
                <Link href="/signup?role=author" className={BRASS_BUTTON_CLASSES}>
                  Sign up
                </Link>
              </>
            )}
            {nav.showLogout && (
              <form action={logout}>
                <button type="submit" className={QUIET_LINK_ON_DARK_CLASSES}>
                  Log out
                </button>
              </form>
            )}
          </nav>

          {nav.showAccountLink && (
            <Link
              href={nav.accountHref}
              aria-label={nav.accountLabel}
              className={`focus-ring flex size-11 items-center justify-center rounded-sm text-primary-foreground ${!user ? "lg:hidden" : ""}`}
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
      </div>
    </header>
  );
}
