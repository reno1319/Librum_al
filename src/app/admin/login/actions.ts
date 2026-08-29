"use server";

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { clearRecoverySession } from "@/lib/recovery-session";
import { ADMIN_LOGIN_PATH, resolveSafeAdminPath } from "@/lib/admin-safe-redirect";

// ADMIN-1A.5: the exact stable copy the design brief requires for any
// sign-in failure -- deliberately NOT src/lib/auth-error.ts's
// translateAuthErrorMessage() (which passes most Supabase messages
// through unchanged, only translating a short known list). Admin
// authentication is a higher-stakes surface: this always shows the same
// generic message regardless of what Supabase actually reported, so a
// crafted request can never distinguish "wrong password" from "no such
// account" from any other failure mode by inspecting the response.
const GENERIC_SIGNIN_ERROR = "Unable to sign in. Check your credentials and try again.";

// Authentication and staff authorization are deliberately kept separate
// here, per the design brief: this action's entire job, after Supabase
// confirms the password is correct, is to land the now-authenticated
// browser back on /admin/login -- it does NOT itself decide "is this
// person allowed into /admin." That decision belongs in exactly one
// place, src/app/admin/login/page.tsx's own already-authenticated branch
// (which calls the same getStaffMember()/roleHasPermission() every other
// admin surface uses), so there is only ever one piece of code in this
// app that answers "does this account have admin.access" -- not a
// duplicate copy here that could drift from it. Reuses the exact same
// Supabase Auth identity/session system as ordinary Librum login
// (src/app/auth/actions.ts's login()) -- no second auth backend, no
// admin password table, no role/owner checkbox, no admin signup path.
export async function staffLogin(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = resolveSafeAdminPath(String(formData.get("next") ?? ""));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // Per LAUNCH-1 P1-11: a failed sign-in attempt must not touch any
    // existing recovery marker either way -- same rule login() already
    // follows, restated here since this is a separate action, not a
    // shared code path.
    redirect(
      `${ADMIN_LOGIN_PATH}?error=${encodeURIComponent(GENERIC_SIGNIN_ERROR)}${
        next ? `&next=${encodeURIComponent(next)}` : ""
      }`,
    );
  }

  // LAUNCH-1 P1-11 STALE-MARKER CORRECTION, same rule login() already
  // follows: a confirmed successful signInWithPassword() is the exact
  // point a stale recovery marker from an earlier, unrelated abandoned
  // recovery attempt in this browser must be cleared, so it can never
  // wrongly restrict this new, unrelated (and possibly staff) session.
  const cookieStore = await cookies();
  clearRecoverySession(cookieStore);

  // Deliberately redirects back to /admin/login, not straight to /admin
  // or straight to `next` -- the page's own render is what actually
  // resolves staff status and either forwards a genuine staff member on
  // or shows the access-denied state for anyone else. This action never
  // assumes a successful Supabase sign-in equals admin authorization.
  redirect(next ? `${ADMIN_LOGIN_PATH}?next=${encodeURIComponent(next)}` : ADMIN_LOGIN_PATH);
}
