"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAuthorRoleWriteClient } from "@/lib/author-role-write-client";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";

const FAILURE_PATH = `/account?error=${encodeURIComponent(
  "We couldn't switch your account to an author account. Please try again.",
)}`;

// BECOME-AUTHOR-1: a signed-in reader turns their own account into an
// author account -- the same account someone gets by choosing "Author"
// at signup, where that choice has never needed approval. No staff step
// and nothing beyond what signup already grants: role = 'author' plus a
// public author name equal to their stored display name, exactly what
// handle_new_user() (migration 045) writes for a new author. The author
// can change that name on their profile page afterwards.
//
// One way only. Nothing here (or anywhere else) turns an author back
// into a reader, and an admin or any other role is never rewritten --
// see src/lib/author-role-write-client.ts for the write rules.
export async function becomeAuthor() {
  // Proxy already blocks /account while a recovery session is active;
  // this is the second layer against a crafted direct POST.
  await redirectIfRecoverySessionActive();

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?next=/account");
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("id, role, display_name")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !profile || profile.id !== user.id) {
    redirect(FAILURE_PATH);
  }

  if (profile.role === "author") {
    redirect("/dashboard");
  }

  if (profile.role !== "reader") {
    redirect(
      `/account?error=${encodeURIComponent("This account can't become an author account.")}`,
    );
  }

  // public_author_name_required_for_authors (migration 045) rejects an
  // author row with a null public name; handle_new_user() never leaves
  // display_name null, so a missing one means an unexpected row.
  const publicAuthorName: unknown = profile.display_name;
  if (typeof publicAuthorName !== "string") {
    redirect(FAILURE_PATH);
  }

  const writer = createAuthorRoleWriteClient();
  const { data: rows, error: updateError } = await writer
    .from("profiles")
    .update({ role: "author", public_author_name: publicAuthorName })
    .eq("id", user.id)
    .eq("role", "reader")
    .select("id, role");

  if (
    updateError ||
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0]?.id !== user.id ||
    rows[0]?.role !== "author"
  ) {
    if (updateError) {
      console.error("becomeAuthor: role update failed", { code: updateError.code ?? "unknown" });
    } else {
      console.error("becomeAuthor: role update did not change exactly the caller's row", {
        rowCount: Array.isArray(rows) ? rows.length : null,
      });
    }
    redirect(FAILURE_PATH);
  }

  revalidatePath("/", "layout");
  redirect(
    `/dashboard?success=${encodeURIComponent(
      "Your account is now an author account. Start by adding your first book.",
    )}`,
  );
}
