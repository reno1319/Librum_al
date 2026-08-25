"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { resolveSiteOrigin } from "@/lib/site-url";
import { clearRecoverySession } from "@/lib/recovery-session";
import { resolveSafeInternalPath } from "@/lib/safe-redirect";
import type { SignupRole } from "@/lib/types";

// Never widen this beyond "author"/"reader" -- signup must never be
// able to produce an "admin" profile. handle_new_user() (migration 028)
// enforces the same whitelist again, independently, at the database
// layer, in case this validation is ever bypassed or this action is
// ever called some other way -- but this is the first line of defense
// against a crafted form submission (formData isn't limited to the
// <select>'s own two options; a raw POST to this Server Action could
// submit anything).
const SIGNUP_ROLES: readonly SignupRole[] = ["author", "reader"];

function resolveSignupRole(value: FormDataEntryValue | null): SignupRole {
  return (SIGNUP_ROLES as readonly string[]).includes(value as string)
    ? (value as SignupRole)
    : "reader";
}

export async function signup(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const displayName = String(formData.get("displayName") ?? "");
  const role = resolveSignupRole(formData.get("role"));

  if (!email || !password || !displayName) {
    redirect("/signup?error=Please+fill+in+every+field");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      data: { display_name: displayName, role },
    },
  });

  if (error) {
    redirect(`/signup?error=${encodeURIComponent(error.message)}`);
  }

  // If email confirmation is required, there's no session yet -- no
  // ordinary authenticated session exists here for a stale recovery
  // marker to wrongly restrict, so nothing is cleared on this path. The
  // later successful non-recovery /auth/callback exchange (the
  // confirmation link itself) is what clears a stale marker once a real
  // session actually exists.
  if (!data.session) {
    redirect("/signup/check-email");
  }

  // LAUNCH-1 P1-11 STALE-MARKER CORRECTION: data.session truthy here
  // means signUp() just established a real, ordinary authenticated
  // session immediately (email confirmation not required by this
  // project) -- the same "clear any stale recovery marker" rule already
  // applied to login() and the callback route's non-recovery branch,
  // for the same reason: a recovery flow abandoned earlier in this same
  // browser must not wrongly restrict this brand-new, unrelated
  // account. Never signs the new session out and never originates a
  // recovery marker -- only ever clears one, exactly like login().
  const cookieStore = await cookies();
  clearRecoverySession(cookieStore);

  revalidatePath("/", "layout");
  redirect(role === "author" ? "/dashboard" : "/");
}

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // LAUNCH-1 P1-11: invalid credentials must leave any existing
    // recovery marker exactly as it was -- a failed login attempt is
    // not evidence that recovery is actually over, and must never
    // downgrade that restriction.
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  // LAUNCH-1 P1-11 STALE-MARKER CORRECTION: signInWithPassword resolving
  // without an error is the exact point ordinary authentication is
  // definitively successful -- clear any stale recovery marker here,
  // before either success redirect below. Without this, a recovery flow
  // abandoned mid-way (marker still present, now long-lived per the
  // sliding-lifetime correction) would incorrectly force a LATER,
  // wholly unrelated successful ordinary login straight back to
  // /reset-password via Proxy's own containment check -- this call is
  // what prevents that. Uses the same centralized clearRecoverySession()
  // logout() already calls -- no cookie name/options duplicated here.
  const cookieStore = await cookies();
  clearRecoverySession(cookieStore);

  revalidatePath("/", "layout");

  // LAUNCH-1 P1: routed through the centralized safe-redirect policy
  // (src/lib/safe-redirect.ts) rather than a local `next.startsWith("/")`
  // check -- that check alone accepted protocol-relative values like
  // "//evil.com/phish", which browsers resolve cross-origin from a
  // redirect. An invalid/unsafe `next` is silently ignored, not sent to an
  // error page -- it just falls through to the normal role-based
  // destination below, exactly as an absent `next` always has.
  const safeNext = resolveSafeInternalPath(next);
  if (safeNext) {
    redirect(safeNext);
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user!.id)
    .single();

  redirect(profile?.role === "author" ? "/dashboard" : "/");
}

export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  // LAUNCH-1 P1-11: a recovery restriction must not outlive the session
  // it was protecting -- logging out mid-recovery ends the restriction
  // along with the session itself, rather than leaving a stale cookie
  // that would then wrongly restrict whatever the user (or a different
  // user, on a shared device) does next.
  const cookieStore = await cookies();
  clearRecoverySession(cookieStore);
  revalidatePath("/", "layout");
  redirect("/");
}

export async function requestPasswordReset(formData: FormData) {
  const email = String(formData.get("email") ?? "").trim();

  if (!email) {
    redirect("/forgot-password?error=Enter+your+email");
  }

  const supabase = await createClient();
  const origin = resolveSiteOrigin();

  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/callback?next=/reset-password`,
  });

  // Always show the same message whether or not that email has an
  // account — otherwise this form could be used to check who's signed up.
  redirect("/forgot-password?success=1");
}

export async function updatePassword(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(
      "/login?error=That+reset+link+has+expired.+Request+a+new+one+from+the+login+page.",
    );
  }

  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!password || password.length < 6) {
    redirect("/reset-password?error=Password+must+be+at+least+6+characters");
  }

  if (password !== confirmPassword) {
    redirect("/reset-password?error=Passwords+don%27t+match");
  }

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    // LAUNCH-1 P1-11: a rejected update leaves recovery genuinely
    // incomplete -- the restriction (and the session it protects) must
    // remain exactly as it was, so a retry lands back on this same
    // restricted state rather than silently losing the restriction on a
    // failed attempt.
    redirect(`/reset-password?error=${encodeURIComponent(error.message)}`);
  }

  // LAUNCH-1 P1-11: recovery is only actually "over" once the new
  // password is confirmed set -- clearing the restriction and signing
  // out happen ONLY on this success path, never on the validation or
  // Supabase-error branches above (both of those `redirect()` calls
  // throw, per Next.js's own convention, so this code is genuinely
  // unreached on any failure). Explicit signOut() rather than trusting
  // Supabase to invalidate the recovery-derived session on its own
  // (unverified from the installed SDK's own source -- see the P1-11
  // audit): the user must authenticate fresh with the new password,
  // which is also the standard, safer UX after any credential change.
  const cookieStore = await cookies();
  clearRecoverySession(cookieStore);
  await supabase.auth.signOut();

  redirect("/login?success=Password+updated.+Log+in+with+your+new+password.");
}
