"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { detectCoverImageKind, resolveVerifiedCoverStorageDetails } from "@/lib/cover-image";
import { AVATARS_BUCKET, canonicalAvatarPath } from "@/lib/avatar-path";
import { createProfileWriteClient } from "@/lib/profile-write-client";

// LIBRUM 2.0 AUTHOR-1A: mirrors migration 045's own CHECK constraint
// exactly (see that migration's comment) -- a value that passes this can
// never fail at the database layer. Kept as its own local constant,
// matching the existing convention for short-text-field limits (see
// SUBTITLE_MAX_LENGTH/PUBLISHER_MAX_LENGTH/EDITION_MAX_LENGTH in
// src/app/dashboard/books/actions.ts) -- deliberately not imported
// across the profile/books module boundary.
const PUBLIC_AUTHOR_NAME_MAX_LENGTH = 120;

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
// Private staging area for an unvalidated, not-yet-saved avatar -- the
// SAME bucket resolveCoverInput() (src/app/dashboard/books/actions.ts)
// already reuses for covers, not something avatar-specific. See
// avatar-field.tsx's own top-of-file comment for why "avatars" itself
// (a genuinely public bucket) is never used for staging.
const STAGING_BUCKET = "manuscripts";

// LIBRUM 2.0 LAUNCH-FIX-1A AVATAR-1: the same normalization pattern as
// resolveCoverInput() (src/app/dashboard/books/actions.ts) -- accepts
// EITHER a small "avatarStoragePath" Storage reference (the new,
// primary path: AvatarField already uploaded the real bytes directly
// to Storage) OR, as defense in depth only, a raw "avatar" File field
// (AvatarField's own file input carries no `name` attribute, so
// nothing in this app's UI submits this way any more -- kept only so
// a hand-crafted request still gets validated, exactly mirroring
// resolveCoverInput's identical fallback branch). Either way, the
// downloaded/received bytes are re-validated here -- size AND real
// byte-signature -- never trusted from the client alone.
type ResolvedAvatar =
  | { present: false }
  | {
      present: true;
      bytes: Buffer;
      extension: "jpg" | "png";
      contentType: "image/jpeg" | "image/png";
      tempPathToCleanup: string | null;
    };

async function resolveAvatarInput(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  formData: FormData,
  errorPath: string,
): Promise<ResolvedAvatar> {
  const tempPath = String(formData.get("avatarStoragePath") ?? "").trim();

  let bytes: Buffer;
  let tempPathToCleanup: string | null = null;

  if (tempPath) {
    if (!tempPath.startsWith(`${userId}/tmp/avatar/`) || !/\.(jpe?g|png)$/i.test(tempPath)) {
      redirect(
        `${errorPath}?error=${encodeURIComponent(
          "That photo reference is no longer valid. Please choose your file again.",
        )}`,
      );
    }

    const { data, error: downloadError } = await supabase.storage
      .from(STAGING_BUCKET)
      .download(tempPath);
    if (downloadError || !data) {
      console.error("resolveAvatarInput: temp avatar download failed:", downloadError);
      redirect(
        `${errorPath}?error=${encodeURIComponent(
          "Could not read your uploaded photo. Please try again.",
        )}`,
      );
    }

    bytes = Buffer.from(await data!.arrayBuffer());
    tempPathToCleanup = tempPath;
  } else {
    const avatar = formData.get("avatar") as File | null;
    if (!avatar || avatar.size === 0) {
      return { present: false };
    }
    bytes = Buffer.from(await avatar.arrayBuffer());
  }

  // Defense in depth -- never trust client-side File.size (or the
  // browser's own pre-upload check) alone for bytes that came back
  // from a temp Storage download.
  if (bytes.length > MAX_AVATAR_BYTES) {
    redirect(`${errorPath}?error=${encodeURIComponent("This image is larger than the 5 MB limit.")}`);
  }

  // The SAME authoritative byte-signature check every cover has always
  // gone through (src/lib/cover-image.ts) -- a temp path's own
  // ".jpg"/".png" extension is only a routing guard above, never proof
  // of real format.
  const avatarFile = new File([new Uint8Array(bytes)], "avatar", {
    type: "application/octet-stream",
  });
  const avatarKind = await detectCoverImageKind(avatarFile);
  if (!avatarKind) {
    redirect(
      `${errorPath}?error=${encodeURIComponent("That doesn't look like a valid JPEG or PNG image.")}`,
    );
  }
  const { extension, contentType } = resolveVerifiedCoverStorageDetails(avatarKind);

  return { present: true, bytes, extension, contentType, tempPathToCleanup };
}

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
    return { action: "reject", message: "Public author name can't be empty" };
  }
  if (value.length > PUBLIC_AUTHOR_NAME_MAX_LENGTH) {
    return {
      action: "reject",
      message: `Public author name must be ${PUBLIC_AUTHOR_NAME_MAX_LENGTH} characters or fewer`,
    };
  }

  return { action: "set", value };
}

// AVATAR-STORAGE-PATH-AUTH-1: every profiles write in this action -- the
// trusted avatar_path write and both session metadata writes -- must prove
// it changed exactly the caller's own row (and, for the avatar write, that
// it stored exactly the path the server derived). Anything else -- no
// rows, several rows, another or a missing id, another path, a non-array
// or null response -- is treated as a failed save. One classifier, so the
// branches cannot drift apart.
function isExactlyOwnProfileRowWritten(
  rows: unknown,
  userId: string,
  expectedAvatarPath?: string,
): boolean {
  if (!Array.isArray(rows) || rows.length !== 1) {
    return false;
  }
  const row = rows[0] as { id?: unknown; avatar_path?: unknown } | null;
  if (row === null || typeof row !== "object" || row.id !== userId) {
    return false;
  }
  return expectedAvatarPath === undefined || row.avatar_path === expectedAvatarPath;
}

const PROFILE_SAVE_ERROR = `/dashboard/profile?error=${encodeURIComponent(
  "We couldn't save your profile. Please try again.",
)}`;

// AVATAR-STORAGE-PATH-AUTH-1: the ordinary profile fields (display_name,
// bio, public_author_name) stay on the least-privileged SESSION client and
// are checked the same way as the trusted write. RLS lets the caller read
// back only their own row, so `.select("id")` returns it under both the
// pre- and post-migration ACL. Returns false on any failure; the caller
// then reports an error and does nothing further. The diagnostic carries
// only the error code and the returned row count -- never a profile value.
async function writeOwnProfileMetadata(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  payload: { display_name: string; bio: string; public_author_name?: string },
): Promise<boolean> {
  const { data: writtenRows, error } = await supabase
    .from("profiles")
    .update(payload)
    .eq("id", userId)
    .select("id");

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
  const bio = String(formData.get("bio") ?? "").trim();

  if (!displayName) {
    redirect("/dashboard/profile?error=Name+can%27t+be+empty");
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

  const avatarResult = await resolveAvatarInput(supabase, user.id, formData, "/dashboard/profile");

  if (avatarResult.present) {
    // Same canonical "<uid>/avatar.<ext>" storage key the pre-AVATAR-1
    // code always used -- unchanged so every already-stored
    // profiles.avatar_path value stays valid, no backfill needed.
    // extension now comes from the verified byte signature, never the
    // client-reported filename. AVATAR-STORAGE-PATH-AUTH-1: built by the
    // one shared definition deleteAccount also checks against, from the
    // session-verified user id only.
    const avatarPath = canonicalAvatarPath(user.id, avatarResult.extension);

    const { error: uploadError } = await supabase.storage
      .from(AVATARS_BUCKET)
      .upload(avatarPath, avatarResult.bytes, {
        contentType: avatarResult.contentType,
        upsert: true,
      });

    if (uploadError) {
      console.error("updateProfile: avatar upload failed:", uploadError);
      redirect(
        `/dashboard/profile?error=${encodeURIComponent(
          "We couldn't upload your profile photo. Please try again.",
        )}`,
      );
    }

    // AVATAR-STORAGE-PATH-AUTH-1: authenticated may no longer write
    // avatar_path (migration 20260924160846), so it is written -- alone --
    // through the trusted server-only writer, created only now that the
    // caller is authenticated, the bytes are validated and the canonical
    // object is uploaded. It is written FIRST: if it fails, nothing else
    // on the profile is changed, no Storage object is removed (the
    // canonical key may be the photo the profile already shows), and the
    // temp object is kept, exactly as after a failed upload.
    const profileWriter = createProfileWriteClient();
    const { data: writtenRows, error: avatarWriteError } = await profileWriter
      .from("profiles")
      .update({ avatar_path: avatarPath })
      .eq("id", user.id)
      .select("id, avatar_path");

    if (avatarWriteError || !isExactlyOwnProfileRowWritten(writtenRows, user.id, avatarPath)) {
      console.error(
        "updateProfile: trusted avatar_path write failed:",
        avatarWriteError ?? `expected exactly one own row, got ${Array.isArray(writtenRows) ? writtenRows.length : "none"}`,
      );
      redirect(
        `/dashboard/profile?error=${encodeURIComponent(
          "We couldn't save your profile photo. Please try again.",
        )}`,
      );
    }

    // The metadata write is separate from the trusted avatar write, so a
    // failure here can leave the new avatar_path and canonical object in
    // place: that is NOT rolled back (a service-role compensation could
    // race another save). The action reports failure, keeps the temp
    // object, skips revalidation and never reports success; retrying is
    // safe.
    if (
      !(await writeOwnProfileMetadata(supabase, user.id, {
        display_name: displayName,
        bio,
        ...publicAuthorNameUpdate,
      }))
    ) {
      redirect(PROFILE_SAVE_ERROR);
    }

    // Only now that the canonical avatar object is written is it safe
    // to remove the temp staging object -- same ordering discipline as
    // createBook/updateBook's own temp cleanup (see resolveCoverInput's
    // comment for the full reasoning). A cleanup failure here is an
    // orphaned-object problem, never a failed save -- logged, not
    // surfaced.
    if (avatarResult.tempPathToCleanup) {
      const { error: cleanupError } = await supabase.storage
        .from(STAGING_BUCKET)
        .remove([avatarResult.tempPathToCleanup]);
      if (cleanupError) {
        console.error("updateProfile: failed to remove temporary avatar object:", cleanupError);
      }
    }
  } else if (
    !(await writeOwnProfileMetadata(supabase, user.id, {
      display_name: displayName,
      bio,
      ...publicAuthorNameUpdate,
    }))
  ) {
    redirect(PROFILE_SAVE_ERROR);
  }

  revalidatePath("/", "layout");
  redirect("/dashboard/profile?success=1");
}
