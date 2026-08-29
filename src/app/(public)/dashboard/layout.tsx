import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { INTERNAL_PATHNAME_HEADER } from "@/lib/internal-headers";
import { resolveSafeInternalPath } from "@/lib/safe-redirect";

// LIBRUM 2.0 AUTH-2: this layout is the single dashboard auth boundary
// (see the AUTH-2 audit) -- every /dashboard/* page, static or dynamic,
// renders under it, so it's the one place that needs to know "where was
// the visitor trying to go" to build a `?next=` that survives the login
// round-trip. request.nextUrl.pathname isn't available to a Server
// Component/Layout directly in this Next.js version; src/proxy.ts's
// updateSession() forwards it as INTERNAL_PATHNAME_HEADER, a request
// header it derives fresh from the real request and unconditionally
// overwrites (never trusts an incoming value of the same name) -- see
// that file's own comment. Re-validated here through the existing
// resolveSafeInternalPath() gate anyway (the same one login()/the auth
// callback already use for their own `next` values) rather than trusted
// blindly, so there is still exactly one function in the codebase that
// decides "is this string safe to put after /login?next=".
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    const headerList = await headers();
    const currentPath = resolveSafeInternalPath(headerList.get(INTERNAL_PATHNAME_HEADER));
    redirect(currentPath ? `/login?next=${encodeURIComponent(currentPath)}` : "/login");
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();

  if (profile?.role !== "author") {
    redirect("/");
  }

  return <>{children}</>;
}
