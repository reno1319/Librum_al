import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/auth/actions";
import { IconPerson } from "@/components/icons";

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

  return (
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-surface px-4 py-4 sm:px-6">
      <div className="flex flex-wrap items-center" style={{ gap: "2rem" }}>
        <Link
          href="/"
          className="font-serif text-xl font-semibold text-primary"
        >
          Librum
        </Link>

        <nav className="flex flex-wrap items-center gap-4 text-sm font-medium">
          <Link href="/" className="hover:underline">
            Home
          </Link>
          <Link href="/bookstore" className="hover:underline">
            Bookstore
          </Link>
          <Link href="/about" className="hover:underline">
            About
          </Link>
          <Link href="/pricing" className="hover:underline">
            Pricing
          </Link>
        </nav>
      </div>

      <nav className="flex flex-wrap items-center gap-4 text-sm">
        {user && (
          <>
            <Link
              href={role === "author" ? "/dashboard" : "/library"}
              className="hover:underline"
            >
              Library
            </Link>
            <span className="hidden text-muted sm:inline">{displayName}</span>
          </>
        )}

        <Link
          href={user ? "/account" : "/login"}
          aria-label={user ? "Account" : "Log in or sign up"}
          className="text-foreground"
        >
          <IconPerson style={{ width: "1.25rem", height: "1.25rem" }} />
        </Link>

        {user && (
          <form action={logout}>
            <button type="submit" className="hover:underline">
              Log out
            </button>
          </form>
        )}
      </nav>
    </header>
  );
}
