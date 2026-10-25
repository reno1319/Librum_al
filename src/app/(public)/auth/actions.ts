"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { resolveSiteOrigin } from "@/lib/site-url";
import { clearRecoverySession } from "@/lib/recovery-session";
import { loginErrorPath, resolveSafeInternalPath } from "@/lib/safe-redirect";
import type { SignupRole } from "@/lib/types";
import { hasAuthorAgeTick } from "@/lib/author-age";
import { AUTHOR_AGE_REQUIRED_MESSAGE } from "@/lib/author-age-statement";
import { recordAgreements } from "@/lib/agreement-records";
import { createAuthorRoleWriteClient } from "@/lib/author-role-write-client";

// Supabase's own wrong-password message, which auth-error.ts translates.
const INVALID_CREDENTIALS_MESSAGE = "Invalid login credentials";

// Never widen this beyond "author"/"reader" -- signup must never be
// able to produce an "admin" profile. The database makes every new
// account a reader (handle_new_user(), SECURITY-9A), and the only
// switch below is reader -> author -- but this is the first line of
// defense against a crafted form submission (formData isn't limited to
// the <select>'s own two options; a raw POST to this Server Action could
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
  // PEN-2 (N3): the name is trimmed; it becomes the display name and, for
  // an author, the public author name and default pen name.
  const rawDisplayName = String(formData.get("displayName") ?? "");
  const displayName = rawDisplayName.trim();
  const role = resolveSignupRole(formData.get("role"));

  if (!email || !password || !rawDisplayName) {
    redirect("/signup?error=Please+fill+in+every+field");
  }
  if (!displayName) {
    // The same message the profile page shows for an empty name.
    redirect("/signup?error=Name+can%27t+be+empty");
  }

  // LAUNCH-1 P2: required, unchecked-by-default signup clickwrap --
  // enforced here, not merely via the checkbox's own `required` HTML
  // attribute, since a direct POST to this Server Action bypasses
  // browser-level form validation entirely. An unchecked checkbox is
  // simply absent from FormData, so `formData.get("accept_terms")` is
  // `null` in that case -- `=== "on"` correctly rejects both that and
  // any other non-"on" value, without needing a separate null check.
  const acceptedTerms = formData.get("accept_terms") === "on";

  if (!acceptedTerms) {
    redirect(
      `/signup?error=${encodeURIComponent(
        "You must agree to the Terms of Service before creating an account.",
      )}`,
    );
  }

  // AUTHOR-AGE-1: an author sign-up needs the "I'm 18 or older" tick
  // (the Terms' rule). Checked here, before the account exists; the page
  // keeps "Author" chosen on the way back.
  if (role === "author" && !hasAuthorAgeTick(formData)) {
    redirect(`/signup?role=author&error=${encodeURIComponent(AUTHOR_AGE_REQUIRED_MESSAGE)}`);
  }

  const supabase = await createClient();
  // AUTH-1E: explicit emailRedirectTo, mirroring requestPasswordReset()'s
  // own explicit redirectTo below -- previously absent here, so a
  // project-level Auth template that honors {{ .RedirectTo }} had no
  // application-supplied value to fall back to for signup confirmation
  // specifically (unlike recovery, which has always set this). Points at
  // the same /auth/callback route recovery already uses; no `next` is
  // appended since that route's own default (redirect to "/") is already
  // the correct post-confirmation destination for signup.
  const origin = resolveSiteOrigin();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // SECURITY-9A: no role. The database ignores one and makes a
      // reader; an author is switched on the server below.
      data: { display_name: displayName },
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    redirect(`/signup?error=${encodeURIComponent(error.message)}`);
  }

  // SECURITY-9A + AUTHOR-AGE-1: record the Terms tick (and, for an
  // author, the 18+ tick) on the new account, then switch an author
  // sign-up from reader to author on the server. With email
  // confirmation on, signUp() answers an address that already has an
  // account with a stand-in user whose identities list is empty; only a
  // user with an identity was really created here, so only that one is
  // written. The account already exists at this point, so a failure is
  // logged and sign-up goes on: an author whose record or switch failed
  // stays a reader (it is never an author without the 18+ record) and is
  // told to use "Become an author" (Renato, "2. a").
  const newUser = data.user;
  const created = Boolean(newUser && (newUser.identities?.length ?? 0) > 0);
  let switchedToAuthor = false;
  if (newUser && created) {
    const recorded = await recordAgreements(newUser.id, { authorAge: role === "author" });
    if (role === "author" && recorded) {
      switchedToAuthor = await switchNewAccountToAuthor(newUser.id, displayName);
    }
  }
  // Only for an account really created here: a stand-in user must get
  // exactly the ordinary answer, or the page would tell whether an
  // address already has an account.
  const authorPending = role === "author" && created && !switchedToAuthor;

  // If email confirmation is required, there's no session yet -- no
  // ordinary authenticated session exists here for a stale recovery
  // marker to wrongly restrict, so nothing is cleared on this path. The
  // later successful non-recovery /auth/callback exchange (the
  // confirmation link itself) is what clears a stale marker once a real
  // session actually exists.
  if (!data.session) {
    redirect(authorPending ? "/signup/check-email?author=pending" : "/signup/check-email");
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
  if (role === "author" && !switchedToAuthor) {
    redirect(`/account?error=${encodeURIComponent(AUTHOR_PENDING_MESSAGE)}`);
  }
  redirect(role === "author" ? "/dashboard" : "/");
}

// SECURITY-9A: shown when an author sign-up ended as a reader.
const AUTHOR_PENDING_MESSAGE =
  "Your account was created as a reader account. To publish, use \"Become an author\" on this page.";

// SECURITY-9A: the database makes every new account a reader, so an
// author sign-up is switched here, with the author-role writer (the
// rules in src/lib/author-role-write-client.ts): only reader -> author,
// only the row of the account signUp() just created, only role and
// public_author_name = the trimmed sign-up name (the row
// handle_new_user() used to write for an author; the database then
// gives the default pen name). Exactly one changed row, now an author,
// or it fails closed. Logged without the id.
async function switchNewAccountToAuthor(userId: string, publicAuthorName: string): Promise<boolean> {
  const { data: rows, error } = await createAuthorRoleWriteClient()
    .from("profiles")
    .update({ role: "author", public_author_name: publicAuthorName })
    .eq("id", userId)
    .eq("role", "reader")
    .select("id, role");
  if (
    error ||
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0]?.id !== userId ||
    rows[0]?.role !== "author"
  ) {
    console.error("signup: the switch to author failed", {
      code: error?.code ?? null,
      rowCount: Array.isArray(rows) ? rows.length : null,
    });
    return false;
  }
  return true;
}

export async function login(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "");

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    // LAUNCH-1 P1-11: invalid credentials must leave any existing
    // recovery marker exactly as it was -- a failed login attempt is
    // not evidence that recovery is actually over, and must never
    // downgrade that restriction.
    //
    // PEOPLE-2: Supabase Auth checks the ban BEFORE the password
    // (supabase/auth internal/api/token.go, ResourceOwnerPasswordGrant),
    // so "User is banned" would tell anyone typing any password that
    // the address has a suspended account. It gets the same generic
    // wrong-password message instead, in the URL too. The person
    // themselves learns of the suspension from the email, and a session
    // Proxy cuts off lands on /login?suspended=1.
    if (error.code === "user_banned") {
      redirect(loginErrorPath(INVALID_CREDENTIALS_MESSAGE, next));
    }
    redirect(loginErrorPath(error.message, next));
  }

  // AUTH-1E FOLLOW-UP: signInWithPassword() has already authenticated
  // this request and returns that authenticated user directly. Do not
  // immediately call getUser() here: in a Server Action, the new auth
  // cookies are being written to the outgoing response and are not a
  // reliable source for a second read during the same request. That
  // re-read returned null in Staging even though the login itself had
  // succeeded, and the later `user!.id` crashed the action. Treat the
  // SDK's defensive nullable type as an explicit failure instead of
  // asserting it away.
  const signedInUser = data.user;
  if (!signedInUser) {
    redirect(loginErrorPath("Unable to complete login. Please try again.", next));
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

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", signedInUser.id)
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

  let resetError: { code?: string; status?: number } | null = null;

  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${origin}/auth/callback?next=/reset-password`,
    });
    resetError = error;
  } catch {
    // Treat a transport/runtime failure exactly like a returned provider
    // error. Do not log the submitted email or the raw exception: either
    // could contain sensitive request information.
    console.error("requestPasswordReset: password-reset provider request threw");
    redirect(
      `/forgot-password?error=${encodeURIComponent(
        "We couldn't send a reset email right now. Please wait and try again.",
      )}`,
    );
  }

  if (resetError) {
    // Supabase intentionally returns success for an unknown address, so
    // this branch does not create an account-existence oracle. It only
    // handles genuine service/rate-limit failures. Keep diagnostics
    // useful but non-sensitive: never log the address or raw message.
    console.error("requestPasswordReset: password-reset provider request failed", {
      code: resetError.code ?? "unknown",
      status: resetError.status ?? null,
    });
    redirect(
      `/forgot-password?error=${encodeURIComponent(
        "We couldn't send a reset email right now. Please wait and try again.",
      )}`,
    );
  }

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
