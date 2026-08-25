"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { resolveSiteOrigin } from "@/lib/site-url";
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

  // If email confirmation is required, there's no session yet.
  if (!data.session) {
    redirect("/signup/check-email");
  }

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
    redirect(`/login?error=${encodeURIComponent(error.message)}`);
  }

  revalidatePath("/", "layout");

  // Only follow same-site relative paths, e.g. "/books/123" — never an
  // absolute URL, which could redirect a user off the site.
  if (next.startsWith("/")) {
    redirect(next);
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
    redirect(`/reset-password?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/login?success=Password+updated.+Log+in+with+your+new+password.");
}
