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
    <header className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
      <Link href="/" className="text-lg font-semibold">
        Dante
      </Link>

      <nav className="flex items-center gap-4 text-sm">
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
            <span className="text-gray-500">{displayName}</span>
            <form action={logout}>
              <button type="submit" className="hover:underline">
                Log out
              </button>
            </form>
          </>
        ) : (
          <>
            <Link href="/login" className="hover:underline">
              Log in
            </Link>
            <Link
              href="/signup"
              className="rounded-md bg-gray-900 px-3 py-1.5 font-medium text-white hover:bg-gray-700"
            >
              Sign up
            </Link>
          </>
        )}
      </nav>
    </header>
  );
}
