import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getStaffMember } from "@/lib/staff";
import { roleHasPermission } from "@/lib/staff-permissions";
import { resolveSafeAdminPath } from "@/lib/admin-safe-redirect";
import { logout } from "@/app/(public)/auth/actions";
import { staffLogin } from "./actions";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { formControlClasses } from "@/lib/form-styles";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Librum Administration",
  description: "Sign in with your Librum staff account.",
};

// ADMIN-1A.5: dedicated staff sign-in entry, separate from the ordinary
// /login page -- reuses the exact same Supabase Auth identity/session
// system (no second auth backend), but keeps authentication and staff
// authorization as two distinct steps, per the design brief:
//   1. Authenticate with Supabase (this page's form -> staffLogin()).
//   2. Resolve the authenticated user against staff_members and require
//      admin.access -- done HERE, on render, using the same
//      getStaffMember()/roleHasPermission() every other admin surface
//      already uses (never a second copy of that check).
// This page is NOT the security boundary for any /admin/* content --
// requireStaff on each actual admin page/action (enforced structurally
// now by admin/(protected)/layout.tsx) remains the real gate, unchanged.
// Arriving here successfully authenticated proves nothing about
// authorization by itself.
export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const { error, next } = await searchParams;
  const safeNext = resolveSafeAdminPath(next);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // Already authenticated (via this page, via ordinary /login earlier
    // in the same browser session, or any other route that establishes a
    // Supabase session) -- resolve staff status fresh, here, rather than
    // trusting anything about how they arrived.
    const staff = await getStaffMember();

    if (staff && roleHasPermission(staff.role, "admin.access")) {
      redirect(safeNext ?? "/admin");
    }

    // A valid Librum account, but not authorized staff. Never sign them
    // out automatically and never mutate their account -- state the
    // fact plainly and let them choose where to go. No staff-table
    // details or internal permission diagnostics are exposed -- this is
    // the one message shown regardless of WHY (no staff_members row at
    // all, or a role that doesn't carry admin.access).
    return (
      <main className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col justify-center px-4">
        <h1 className="font-serif text-3xl font-semibold">Librum Administration</h1>
        <Alert variant="error" className="mt-6">
          This account does not have access to Librum Administration.
        </Alert>
        <div className="mt-6 flex flex-col gap-3">
          <Link href="/" className={buttonClasses("primary", "md")}>
            Return to Librum
          </Link>
          <form action={logout}>
            <button type="submit" className={buttonClasses("outline", "md", "w-full")}>
              Sign out
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-[80vh] w-full max-w-sm flex-col justify-center px-4">
      <h1 className="font-serif text-3xl font-semibold">Librum Administration</h1>
      <p className="mt-1 text-sm text-muted">Sign in with your Librum staff account.</p>

      {error && (
        <Alert variant="error" className="mt-4">
          {error}
        </Alert>
      )}

      <form action={staffLogin} className="mt-6 flex flex-col gap-4">
        {safeNext && <input type="hidden" name="next" value={safeNext} />}
        <label className="flex flex-col gap-1 text-sm">
          Email
          <input
            name="email"
            type="email"
            autoComplete="email"
            required
            className={formControlClasses}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className={formControlClasses}
          />
        </label>

        <button type="submit" className={`mt-2 ${buttonClasses("primary", "md")}`}>
          Sign in
        </button>
      </form>

      <p className="mt-4 text-sm text-muted">
        <Link href="/forgot-password" className="focus-ring rounded-sm hover:underline">
          Forgot your password?
        </Link>
      </p>
    </main>
  );
}
