import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/auth/actions";
import { IconBag, IconPerson } from "@/components/icons";

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
      <div
        className="flex flex-wrap items-center"
        style={{ gap: "2rem" }}
      >
        <Link
          href="/"
          className="font-serif text-xl font-semibold text-primary"
        >
          Librum
        </Link>

        <nav className="flex flex-wrap items-center gap-4 text-sm">
          <Link href="/about" className="hover:underline">
            About
          </Link>
          <Link href="/how-it-works" className="hover:underline">
            How it works
          </Link>
          <Link href="/pricing" className="hover:underline">
            Pricing
          </Link>
          <Link
            href={role === "author" ? "/dashboard/books/new" : "/signup?role=author"}
            className="hover:underline"
          >
            Create
          </Link>
          <Link href="/products" className="hover:underline">
            Products
          </Link>
          <Link href="/program" className="hover:underline">
            Program
          </Link>
          <Link href="/bookstore" className="hover:underline">
            Bookstore
          </Link>
        </nav>
      </div>

      <nav className="flex flex-wrap items-center gap-4 text-sm">
        {user && (
          <>
            {role === "author" && (
              <Link href="/dashboard" className="hover:underline">
                Dashboard
              </Link>
            )}
            <Link href="/library" className="hover:underline">
              Library
            </Link>
            <Link href="/wishlist" className="hover:underline">
              Wishlist
            </Link>
            <Link href="/following" className="hover:underline">
              Following
            </Link>
            <span className="hidden text-muted sm:inline">{displayName}</span>
          </>
        )}

        <Link href="/cart" aria-label="Cart" className="text-foreground">
          <IconBag style={{ width: "1.25rem", height: "1.25rem" }} />
        </Link>
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
