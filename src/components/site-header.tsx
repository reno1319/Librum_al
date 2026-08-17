import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/app/auth/actions";

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
      <Link href="/" className="font-serif text-xl font-semibold text-primary">
        Librum
      </Link>

      <nav className="flex flex-wrap items-center gap-4 text-sm">
        {user ? (
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
            <Link href="/account" className="hover:underline">
              Account
            </Link>
            <span className="hidden text-muted sm:inline">{displayName}</span>
            <form action={logout}>
              <button type="submit" className="hover:underline">
                Log out
              </button>
            </form>
          </>
        ) : (
          <>
            <Link href="/how-it-works" className="hover:underline">
              How it works
            </Link>
            <Link href="/pricing" className="hover:underline">
              Pricing
            </Link>
            <Link href="/login" className="hover:underline">
              Log in
            </Link>
            <Link
              href="/signup"
              className="rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground hover:bg-primary-hover"
            >
              Sign up
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
