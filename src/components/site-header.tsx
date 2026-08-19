import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/auth/actions";
import { IconPerson } from "@/components/icons";
import { NavLinks, type NavItem } from "@/components/nav-links";
import { MobileNav } from "@/components/mobile-nav";

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

  const primaryLinks: NavItem[] = [
    { href: "/", label: "Home" },
    { href: "/bookstore", label: "Bookstore" },
    { href: "/about", label: "About" },
    { href: "/pricing", label: "Pricing" },
  ];

  // Role-correct label — never "Library" for an author, never "Dashboard"
  // for a reader. Authors can still browse/buy books via Bookstore above;
  // this is just their management-area link.
  if (user) {
    primaryLinks.push(
      role === "author"
        ? { href: "/dashboard", label: "Dashboard" }
        : { href: "/library", label: "Library" },
    );
  }

  const accountHref = user ? "/account" : "/login";
  const accountLabel = user ? "Account" : "Log in or sign up";

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
          <NavLinks items={primaryLinks} />
        </nav>
      </div>

      <div className="flex items-center gap-3">
        <nav className="hidden items-center gap-4 text-sm md:flex">
          {user && displayName && (
            <span className="text-muted">{displayName}</span>
          )}
          {user && (
            <form action={logout}>
              <button type="submit" className="hover:underline">
                Log out
              </button>
            </form>
          )}
        </nav>

        <Link
          href={accountHref}
          aria-label={accountLabel}
          className="flex items-center justify-center text-foreground"
          style={{ width: "2.75rem", height: "2.75rem" }}
        >
          <span aria-hidden="true">
            <IconPerson style={{ width: "1.25rem", height: "1.25rem" }} />
          </span>
        </Link>

        <MobileNav
          items={primaryLinks}
          loggedIn={!!user}
          accountHref={accountHref}
          logoutAction={logout}
        />
      </div>
    </header>
  );
}
