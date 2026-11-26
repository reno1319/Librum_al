import { cookies } from "next/headers";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/(public)/auth/actions";
import { isRecoverySessionActive } from "@/lib/recovery-session";
import { IconBag, IconHeart, IconPerson } from "@/components/icons";
import { NavLinks, type NavItem } from "@/components/nav-links";
import { MobileNav } from "@/components/mobile-nav";
import { FeedbackButton } from "@/components/feedback-button";
import { accountFirstName } from "@/lib/account-first-name";
import { LibrumLogo } from "@/components/librum-logo";
import { StaffBar } from "@/components/staff-bar";
import { roleHasPermission } from "@/lib/staff-permissions";
import { cartCountLabel } from "@/lib/cart";
import type { StaffRole } from "@/lib/types";

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
  // HEADER NAME (Renato 1a 2a 3a): the account's first name, shown
  // beside the person icon on every page and width; null when there is
  // no real name (see accountFirstName) or no ordinary session.
  headerName: string | null;
  showAccountLink: boolean;
  showLogout: boolean;
  recoveryLabel: string | null;
  accountHref: string;
  accountLabel: string;
};

export function buildSiteHeaderNav(params: {
  user: { id: string; email?: string | null } | null;
  displayName: string | null;
  role: string | null;
  recoveryActive: boolean;
}): SiteHeaderNavState {
  const { user, displayName, role, recoveryActive } = params;

  const accountHref = user ? "/account" : "/login";
  const accountLabel = user ? "Llogaria" : "Hyr ose regjistrohu";

  if (recoveryActive) {
    return {
      primaryLinks: [],
      headerName: null,
      showAccountLink: false,
      showLogout: true,
      recoveryLabel: "Rikthimi i fjalëkalimit",
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
  // D2 (Renato 11-04): the "Kryefaqja" (Home) link is removed; the logo
  // already links home.
  const primaryLinks: NavItem[] = [
    { href: "/rreth-nesh", label: "Rreth nesh" },
    { href: "/si-funksionon", label: "Si funksionon" },
    { href: "/fitimet", label: "Fitimet" },
    { href: "/librari", label: "Libraria" },
    { href: "/blog", label: "Blog" },
  ];
  if (user) {
    primaryLinks.push(
      role === "author"
        ? { href: "/dashboard", label: "Paneli" }
        : { href: "/library", label: "Biblioteka ime" },
    );
  }

  const headerName = user ? accountFirstName(displayName, user.email) : null;

  return {
    primaryLinks,
    headerName,
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
  "focus-ring inline-flex items-center rounded-full border border-primary-foreground/40 px-4 py-2.5 font-semibold text-primary-foreground transition-colors hover:border-primary-foreground hover:bg-primary-hover";
// FIX1 (X12): "Log out" is a quiet cream text link, quieter than any
// button on the page; the outline button stays for "Log in" only.
const QUIET_LINK_ON_DARK_CLASSES =
  "focus-ring rounded-sm text-primary-foreground/85 underline underline-offset-4 transition-colors hover:text-primary-foreground hover:decoration-2";
const BRASS_BUTTON_CLASSES =
  "focus-ring inline-flex items-center rounded-full bg-accent px-4 py-2.5 font-semibold text-accent-foreground transition-colors hover:bg-primary-foreground";

// LR1 (Renato 11-25, sketch pictures r4, lb7 b): Libraria's own header.
// "store" is chosen by src/app/(public)/layout.tsx for /librari only;
// every other page keeps "default", byte-for-byte today's header.
export type SiteHeaderVariant = "default" | "store";

export async function SiteHeader({ variant = "default" }: { variant?: SiteHeaderVariant } = {}) {
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

  // Staff bar (dashboard batch 1, b1q3 a): reads only the signed-in
  // person's own staff_members row, the same read loadStaffContext() in
  // lib/staff.ts makes. No row, or any error, means no bar.
  let staffRole: StaffRole | null = null;
  if (user) {
    const { data: staffRow } = await supabase
      .from("staff_members")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();
    staffRole = (staffRow?.role as StaffRole | undefined) ?? null;
  }

  const cookieStore = await cookies();
  const recoveryActive = isRecoverySessionActive(cookieStore);

  // CART (item 32, c2 a): how many rows the signed-in reader's cart has.
  // Only the reader's own rows come back (row rules); an error shows the
  // cart with no number.
  let cartCount = 0;
  if (user && !recoveryActive) {
    const { count } = await supabase
      .from("cart_items")
      .select("id", { count: "exact", head: true })
      .eq("reader_id", user.id);
    cartCount = count ?? 0;
  }

  const nav = buildSiteHeaderNav({
    user: user ? { id: user.id, email: user.email } : null,
    displayName,
    role,
    recoveryActive,
  });

  const staffBar = staffRole && !recoveryActive && (
    <StaffBar
      canWritePosts={roleHasPermission(staffRole, "blog.manage")}
      canViewBooks={roleHasPermission(staffRole, "reports.view")}
    />
  );

  if (variant === "store") {
    return (
      <header className="relative bg-primary text-primary-foreground">
        {staffBar}
        <StoreHeaderRow
          signedIn={!!user}
          recoveryActive={recoveryActive}
          headerName={nav.headerName}
          accountHref={nav.accountHref}
          accountLabel={nav.accountLabel}
          cartCount={cartCount}
        />
        {user && !recoveryActive && <FeedbackButton />}
      </header>
    );
  }

  return (
    <header className="relative bg-primary text-primary-foreground">
      {staffBar}
      {/* FIX1 (X12): one row from 1024px up -- no wrapping at lg, and
          tighter gaps there; the roomier gaps return at xl. */}
      {/* HEADER NAME: one row at every width now (below lg it only ever
          held the logo and the right-hand icons); on phones the name in
          the right group shrinks first, never the logo. */}
      <div className="page-container flex flex-nowrap items-center justify-between gap-x-4 py-3 sm:gap-x-8 lg:gap-x-4 xl:gap-x-8">
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-8 gap-y-2 lg:flex-nowrap lg:gap-x-4 xl:gap-x-8">
          {/* LOGO (Renato 11-18, lg1 a): the "librum." wordmark, the same
              height as the old serif "Librum" so the header row doesn't move.
              lg2 a: the padding keeps the old 42px tap height; the
              negative margin cancels it, so nothing moves. */}
          <Link
            href="/"
            className="focus-ring -my-[9px] block rounded-sm py-[9px] text-primary-foreground"
          >
            <LibrumLogo className="block h-6 w-auto" />
          </Link>

          {/* Wraps onto a second row rather than scrolling sideways when
              the labels get longer. From lg to xl the Albanian labels of
              a signed-in author (with "Paneli i autorit", "Dil" and the
              greeting) ran into the right-hand group, so that range uses
              slightly smaller text and gaps, and this group no longer
              shrinks: the name in the greeting is shortened instead. */}
          <nav aria-label="Kryesore" className="hidden flex-wrap items-center gap-x-6 gap-y-2 text-base font-medium lg:flex lg:flex-nowrap lg:gap-x-3 lg:text-[0.9375rem] lg:whitespace-nowrap xl:gap-x-6 xl:text-base">
            <NavLinks items={nav.primaryLinks} onDark />
          </nav>
        </div>

        <div className="flex min-w-0 items-center gap-3">
          <nav aria-label="Llogaria" className="hidden items-center gap-4 text-base lg:flex lg:whitespace-nowrap">
            {nav.recoveryLabel && (
              <span className="text-primary-foreground/80">{nav.recoveryLabel}</span>
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
                  Hyr
                </Link>
                {/* FIX1 (X2): Author chosen, as on Earnings. */}
                <Link href="/signup?role=author" className={BRASS_BUTTON_CLASSES}>
                  Regjistrohu
                </Link>
              </>
            )}
            {nav.showLogout && (
              <form action={logout}>
                <button type="submit" className={QUIET_LINK_ON_DARK_CLASSES}>
                  Dil
                </button>
              </form>
            )}
          </nav>

          {/* HEADER NAME (Renato 1a 2a 3a; r2 "Hello, " before it): the
              greeting with the first name and the person
              icon are one Account link, on every page and width. It
              replaces FIX1's full name (1280px+ only). A long name ends in
              an ellipsis at about 12 letters, and shrinks further rather
              than wrap the bar on a narrow phone. The accessible name
              starts with the visible text. */}
          {/* CART (item 32): the bag, signed-in readers only (c2 a), from
              1024px up. On phones the cart is a line in the menu (p1 c),
              so the greeting keeps its room. */}
          {user && !recoveryActive && (
            <Link
              href="/shporta"
              aria-label={cartCount > 0 ? `Shporta, ${cartCountLabel(cartCount)}` : "Shporta"}
              className="focus-ring relative hidden size-11 shrink-0 items-center justify-center rounded-sm text-primary-foreground lg:flex"
            >
              <span aria-hidden="true">
                <IconBag className="size-5" />
              </span>
              {cartCount > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute top-1 right-0.5 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-accent px-1 text-[0.6875rem] font-bold text-accent-foreground"
                >
                  {cartCount > 99 ? "99+" : cartCount}
                </span>
              )}
            </Link>
          )}
          {nav.showAccountLink &&
            (nav.headerName ? (
              <Link
                href={nav.accountHref}
                aria-label={`Përshëndetje, ${nav.headerName}, ${nav.accountLabel}`}
                title={`Përshëndetje, ${nav.headerName}`}
                className="focus-ring flex min-h-11 min-w-0 items-center gap-2 rounded-sm px-1.5 text-base font-medium text-primary-foreground"
              >
                {/* r2 (Renato 11:52Z): "Hello, " stays whole; only the name
                    is shortened. */}
                <span className="flex min-w-0 items-baseline">
                  <span className="shrink-0 whitespace-pre">Përshëndetje, </span>
                  <span className="min-w-0 max-w-[12ch] truncate">{nav.headerName}</span>
                </span>
                <span aria-hidden="true" className="shrink-0">
                  <IconPerson className="size-5" />
                </span>
              </Link>
            ) : (
              <Link
                href={nav.accountHref}
                aria-label={nav.accountLabel}
                className={`focus-ring flex size-11 shrink-0 items-center justify-center rounded-sm text-primary-foreground ${!user ? "lg:hidden" : ""}`}
              >
                <span aria-hidden="true">
                  <IconPerson className="size-5" />
                </span>
              </Link>
            ))}

          <MobileNav
            items={nav.primaryLinks}
            loggedIn={!!user}
            accountHref={nav.accountHref}
            logoutAction={logout}
            cartCount={user && !recoveryActive ? cartCount : null}
            recoveryActive={recoveryActive}
          />
        </div>
      </div>
      {/* K4 feedback b a: signed-in people only, never mid password reset. */}
      {user && !recoveryActive && <FeedbackButton />}
    </header>
  );
}

// LR1: the shop header row. Logo, the search (it sends ?q= to Libraria),
// "Lista ime" (the wishlist) and "Shporta" (the cart) as labelled icons,
// then the account: signed out, "Krijo llogari" with "Keni llogari?
// Hyni" under it; signed in, the same greeting link as every other page,
// and "Dil". No menu links and no menu button (lb7 b); the footer still
// links every page. Signed-out taps on the two icons go through log in
// first. On phones the search drops to its own full-width row.
const STORE_ICON_LINK =
  "focus-ring flex min-h-11 min-w-11 flex-col items-center justify-center gap-0.5 rounded-sm px-1 text-[0.6875rem] text-primary-foreground sm:text-[0.8125rem]";

function StoreHeaderRow({
  signedIn,
  recoveryActive,
  headerName,
  accountHref,
  accountLabel,
  cartCount,
}: {
  signedIn: boolean;
  recoveryActive: boolean;
  headerName: string | null;
  accountHref: string;
  accountLabel: string;
  cartCount: number;
}) {
  const showIcons = !recoveryActive;
  return (
    <div className="page-container flex flex-wrap items-center gap-x-4 gap-y-3 py-3 sm:gap-x-6 md:flex-nowrap">
      <Link href="/" className="focus-ring -my-[9px] block shrink-0 rounded-sm py-[9px] text-primary-foreground">
        <LibrumLogo className="block h-6 w-auto" />
      </Link>

      <form
        action="/librari"
        method="get"
        role="search"
        className="relative order-last flex w-full md:order-none md:max-w-[32.5rem] md:flex-1"
      >
        <label htmlFor="store-header-q" className="sr-only">
          Kërko në Librum
        </label>
        {/* 16px text so iPhone Safari does not zoom in. */}
        <input
          id="store-header-q"
          type="search"
          name="q"
          placeholder="Kërko në Librum"
          className="focus-ring h-11 w-full min-w-0 rounded-full border-0 bg-[#f7f3ea] pr-12 pl-5 text-base text-foreground"
        />
        <button
          type="submit"
          aria-label="Kërko"
          className="focus-ring absolute top-0 right-0 flex size-11 items-center justify-center rounded-full text-primary"
        >
          <svg aria-hidden="true" viewBox="0 0 20 20" className="size-4">
            <circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M13 13l4.5 4.5" stroke="currentColor" strokeWidth="2" />
          </svg>
        </button>
      </form>

      <div className="ml-auto flex items-center gap-2 sm:gap-4">
        {showIcons && (
          <>
            <Link href={signedIn ? "/wishlist" : "/login?next=/wishlist"} className={STORE_ICON_LINK}>
              <IconHeart className="size-6" />
              <span>Lista ime</span>
            </Link>
            <Link
              href={signedIn ? "/shporta" : "/login?next=/shporta"}
              aria-label={cartCount > 0 ? `Shporta, ${cartCountLabel(cartCount)}` : undefined}
              className={`${STORE_ICON_LINK} relative`}
            >
              <IconBag className="size-6" />
              <span>Shporta</span>
              {cartCount > 0 && (
                <span
                  aria-hidden="true"
                  className="absolute top-0 right-0 flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-accent px-1 text-[0.6875rem] font-bold text-accent-foreground"
                >
                  {cartCount > 99 ? "99+" : cartCount}
                </span>
              )}
            </Link>
          </>
        )}

        {!signedIn ? (
          <div className="flex flex-col items-center gap-1">
            <Link href="/signup" className={`${BRASS_BUTTON_CLASSES} px-3! py-1.5! text-sm sm:px-4! sm:py-2! sm:text-base`}>
              Krijo llogari
            </Link>
            <span className="text-[0.6875rem] text-primary-foreground/90 sm:text-xs">
              Keni llogari?{" "}
              <Link href="/login" className={QUIET_LINK_ON_DARK_CLASSES}>
                Hyni
              </Link>
            </span>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-3">
            {recoveryActive && <span className="hidden text-primary-foreground/80 sm:inline">Rikthimi i fjalëkalimit</span>}
            {!recoveryActive && (
              <Link
                href={accountHref}
                aria-label={headerName ? `Përshëndetje, ${headerName}, ${accountLabel}` : accountLabel}
                className="focus-ring flex min-h-11 min-w-0 items-center gap-2 rounded-sm px-1.5 text-base font-medium text-primary-foreground"
              >
                {headerName && (
                  <span className="hidden min-w-0 items-baseline sm:flex">
                    <span className="shrink-0 whitespace-pre">Përshëndetje, </span>
                    <span className="max-w-[12ch] min-w-0 truncate">{headerName}</span>
                  </span>
                )}
                <span aria-hidden="true" className="shrink-0">
                  <IconPerson className="size-5" />
                </span>
              </Link>
            )}
            <form action={logout} className={recoveryActive ? "block" : "hidden lg:block"}>
              <button type="submit" className={QUIET_LINK_ON_DARK_CLASSES}>
                Dil
              </button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
