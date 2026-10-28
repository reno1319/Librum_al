"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { PEN_NAME_TAKEN_MESSAGE } from "@/lib/pen-names";
import { ACCOUNT_NAME_MAX_LENGTH, ACCOUNT_NAME_TOO_LONG_MESSAGE } from "@/lib/account-name";

// LIBRUM 2.0 AUTHOR-1A: mirrors migration 045's own CHECK constraint
// exactly (see that migration's comment) -- a value that passes this can
// never fail at the database layer. Kept as its own local constant,
// matching the existing convention for short-text-field limits (see
// SUBTITLE_MAX_LENGTH/PUBLISHER_MAX_LENGTH/EDITION_MAX_LENGTH in
// src/app/dashboard/books/actions.ts) -- deliberately not imported
// across the profile/books module boundary.
const PUBLIC_AUTHOR_NAME_MAX_LENGTH = 120;

// PEN-NAMES-1 r4 (owner decision 18a): Dashboard > Profile no longer
// edits a bio or a photo -- those belong to each pen name (Dashboard >
// Pen names). updateProfile writes only display_name and, for an author,
// public_author_name, on the session client; it never touches Storage,
// profiles.bio or profiles.avatar_path, and ignores any bio, avatar or
// avatarStoragePath field a request carries. The migration copied each
// author's existing profile bio and photo onto their default pen name
// (17a). profiles.avatar_path is still read by deleteAccount, which
// removes that object with the account.

// LIBRUM 2.0 AUTHOR-1A: whether the CURRENT request may write
// public_author_name at all, and if so, the validated value to write.
// Deliberately re-derives role from the authenticated profile's own row
// (never a client-submitted role) -- a reader crafting a
// publicAuthorName field into their FormData must be silently ignored,
// not rejected with an error that would leak that the field exists for
// authors, and never accidentally written. `absent` (the field wasn't
// submitted at all) and `blank` (submitted but empty/whitespace-only)
// are deliberately distinct: an author's own form always includes this
// field with a real defaultValue (see dashboard/profile/page.tsx), so a
// genuinely blank submission from an author is a mistake worth
// rejecting -- but the field being entirely ABSENT (a reader's form
// never renders it, or a legitimate partial FormData) must never be
// treated as "clear it", only "leave it untouched".
type PublicAuthorNameResolution =
  | { action: "skip" }
  | { action: "set"; value: string }
  | { action: "reject"; message: string };

function resolvePublicAuthorNameSubmission(
  formData: FormData,
  isAuthor: boolean,
): PublicAuthorNameResolution {
  if (!isAuthor || !formData.has("publicAuthorName")) {
    return { action: "skip" };
  }

  const value = String(formData.get("publicAuthorName") ?? "").trim();

  if (!value) {
    return { action: "reject", message: "Emri publik i autorit nuk mund të jetë bosh" };
  }
  if (value.length > PUBLIC_AUTHOR_NAME_MAX_LENGTH) {
    return {
      action: "reject",
      message: `Emri publik i autorit mund të ketë deri në ${PUBLIC_AUTHOR_NAME_MAX_LENGTH} karaktere`,
    };
  }

  return { action: "set", value };
}

// AVATAR-STORAGE-PATH-AUTH-1: the profiles write in this action must
// prove it changed exactly the caller's own row. Anything else -- no rows,
// several rows, another or a missing id, a non-array or null response --
// is treated as a failed save.
function isExactlyOwnProfileRowWritten(rows: unknown, userId: string): boolean {
  if (!Array.isArray(rows) || rows.length !== 1) {
    return false;
  }
  const row = rows[0] as { id?: unknown } | null;
  return row !== null && typeof row === "object" && row.id === userId;
}

const PROFILE_SAVE_ERROR = `/dashboard/profile?error=${encodeURIComponent(
  "Profili nuk u ruajt dot. Provoni përsëri.",
)}`;

// AVATAR-STORAGE-PATH-AUTH-1: the profile fields (display_name and
// public_author_name; bio no longer since PEN-NAMES-1 r4) stay on the least-privileged SESSION client and
// are checked the same way as the trusted write. RLS lets the caller read
// back only their own row, so `.select("id")` returns it under both the
// pre- and post-migration ACL. Returns false on any failure; the caller
// then reports an error and does nothing further. The diagnostic carries
// only the error code and the returned row count -- never a profile value.
async function writeOwnProfileMetadata(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  payload: { display_name: string; public_author_name?: string },
): Promise<boolean> {
  const { data: writtenRows, error } = await supabase
    .from("profiles")
    .update(payload)
    .eq("id", userId)
    .select("id");

  // PEN-NAMES-1: the Public author name is the default pen name; the
  // database refuses one equal to another of the author's pen names
  // (LB453), and the author is told why.
  if ((error as { code?: unknown } | null)?.code === "LB453") {
    redirect(`/dashboard/profile?error=${encodeURIComponent(PEN_NAME_TAKEN_MESSAGE)}`);
  }
  if (error || !isExactlyOwnProfileRowWritten(writtenRows, userId)) {
    console.error("updateProfile: profile details update failed", {
      code: (error as { code?: unknown } | null)?.code ?? null,
      rows: Array.isArray(writtenRows) ? writtenRows.length : null,
    });
    return false;
  }
  return true;
}

export async function updateProfile(formData: FormData) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // LIBRUM 2.0 AUTHOR-1A: the authorization source of truth for whether
  // this request may touch public_author_name -- read fresh from the
  // caller's own row, never from anything the form submitted. A profile
  // read failure here fails closed (isAuthor = false): a reader-shaped
  // outcome (public_author_name silently skipped) is always the safe
  // default when role can't be confirmed, never the reverse.
  const { data: currentProfile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .single();
  const isAuthor = currentProfile?.role === "author";

  const displayName = String(formData.get("displayName") ?? "").trim();

  if (!displayName) {
    redirect(`/dashboard/profile?error=${encodeURIComponent("Emri nuk mund të jetë bosh")}`);
  }
  if (displayName.length > ACCOUNT_NAME_MAX_LENGTH) {
    redirect(`/dashboard/profile?error=${encodeURIComponent(ACCOUNT_NAME_TOO_LONG_MESSAGE)}`);
  }

  const publicAuthorNameResolution = resolvePublicAuthorNameSubmission(formData, isAuthor);
  if (publicAuthorNameResolution.action === "reject") {
    redirect(
      `/dashboard/profile?error=${encodeURIComponent(publicAuthorNameResolution.message)}`,
    );
  }
  const publicAuthorNameUpdate =
    publicAuthorNameResolution.action === "set"
      ? { public_author_name: publicAuthorNameResolution.value }
      : {};

  if (
    !(await writeOwnProfileMetadata(supabase, user.id, {
      display_name: displayName,
      ...publicAuthorNameUpdate,
    }))
  ) {
    redirect(PROFILE_SAVE_ERROR);
  }

  revalidatePath("/", "layout");
  redirect("/dashboard/profile?success=1");
}
