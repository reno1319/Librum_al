"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { randomUUID } from "crypto";
import { createClient } from "@/lib/supabase/server";
import { createAuthorRoleWriteClient } from "@/lib/author-role-write-client";
import { createPenNameWriteClient } from "@/lib/pen-name-write-client";
import { canonicalPenNamePhotoPath, type PenNamePhotoExtension } from "@/lib/pen-name-photo-path";
import { AVATARS_BUCKET, isOwnCanonicalAvatarPath } from "@/lib/avatar-path";
import { redirectIfRecoverySessionActive } from "@/lib/recovery-guard";

const FAILURE_PATH = `/account?error=${encodeURIComponent(
  "We couldn't switch your account to an author account. Please try again.",
)}`;

// PEN-2 (N3): the same message the profile page shows for an empty public
// author name (dashboard/profile/actions.ts).
const EMPTY_NAME_PATH = `/account?error=${encodeURIComponent("Public author name can't be empty")}`;

// PEN-2 (17a after C8): the contract migration stops the default pen name
// from taking the account's photo key, because that key
// (`<account id>/avatar.<ext>`) names the account. If the reader had the
// legacy account photo and the object exists, the server copies it to a
// fresh `<random uuid>/pen-name.<ext>` key and sets that on the new
// default pen name, with the pen-name writer (service role, so the copy
// has no owner). It compares-and-sets the pen name's photo (still empty,
// or still the legacy key the database copied before the contract), and
// removes its own copy if that misses. Nothing here can fail the switch
// itself: every failure is logged without a key and the author can add a
// photo on the pen names page.
async function copyLegacyPhotoToDefaultPenName(
  userId: string,
  legacyPath: string,
  extension: PenNamePhotoExtension,
): Promise<void> {
  const writer = createPenNameWriteClient();
  const { data: penName, error: readError } = await writer
    .from("pen_names")
    .select("id, avatar_path")
    .eq("author_id", userId)
    .eq("is_default", true)
    .maybeSingle<{ id: string; avatar_path: string | null }>();
  if (readError || !penName) {
    console.error("becomeAuthor: default pen name not found for the photo copy");
    return;
  }
  if (penName.avatar_path !== null && penName.avatar_path !== legacyPath) {
    return;
  }

  const newPath = canonicalPenNamePhotoPath(randomUUID(), extension);
  const { error: copyError } = await writer.storage.from(AVATARS_BUCKET).copy(legacyPath, newPath);
  if (copyError) {
    // Includes the object being gone: then there is nothing to copy.
    console.warn("becomeAuthor: legacy photo not copied");
    return;
  }

  const update = writer
    .from("pen_names")
    .update({ avatar_path: newPath })
    .eq("id", penName.id)
    .eq("author_id", userId);
  const { data: rows, error: writeError } = await (penName.avatar_path === null
    ? update.is("avatar_path", null)
    : update.eq("avatar_path", legacyPath)
  ).select("id");
  if (writeError || !Array.isArray(rows) || rows.length !== 1) {
    console.error("becomeAuthor: pen name photo not set; the copy is removed");
    await writer.storage.from(AVATARS_BUCKET).remove([newPath]);
  }
}

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
    .select("id, role, display_name, avatar_path")
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
  const storedName: unknown = profile.display_name;
  if (typeof storedName !== "string") {
    redirect(FAILURE_PATH);
  }
  // PEN-2 (N3): the stored name becomes the public author name and the
  // default pen name, so it is trimmed; an empty one is refused with the
  // profile page's own message instead of a database error.
  const publicAuthorName = storedName.trim();
  if (publicAuthorName === "") {
    redirect(EMPTY_NAME_PATH);
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

  const legacyPhoto: unknown = profile.avatar_path;
  if (isOwnCanonicalAvatarPath(legacyPhoto, user.id)) {
    const extension: PenNamePhotoExtension = legacyPhoto.endsWith(".png") ? "png" : "jpg";
    await copyLegacyPhotoToDefaultPenName(user.id, legacyPhoto, extension);
  }

  revalidatePath("/", "layout");
  redirect(
    `/dashboard?success=${encodeURIComponent(
      "Your account is now an author account. Start by adding your first book.",
    )}`,
  );
}
