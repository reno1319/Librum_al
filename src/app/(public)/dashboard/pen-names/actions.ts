"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { detectCoverImageKind, resolveVerifiedCoverStorageDetails } from "@/lib/cover-image";
import { IMAGE_CACHE_CONTROL_SECONDS, PEN_NAME_PHOTO_SIZE, shrinkImageToJpeg } from "@/lib/cover-resize";
import { AVATARS_BUCKET } from "@/lib/avatar-path";
import { createPenNameWriteClient } from "@/lib/pen-name-write-client";
import { canonicalPenNamePhotoPath, isPenNamePhotoPath } from "@/lib/pen-name-photo-path";
import {
  PEN_NAME_BIO_MAX_LENGTH,
  PEN_NAME_PHOTO_MAX_BYTES,
  PEN_NAME_TAKEN_MESSAGE,
  authorPagePath,
  parsePenNameLinks,
  parsePenNameName,
  penNameErrorMessage,
} from "@/lib/pen-names";

// PEN-NAMES-1 (migration 20261019184512): Dashboard > Pen names.
//
//   * name, bio and links: the author's SESSION client, which may update
//     exactly those three columns of its own rows (column grant + RLS);
//   * the photo: validated here, then uploaded and its path written with
//     the server-only pen name writer, under a fresh random folder
//     (src/lib/pen-name-photo-path.ts) so its address never names the
//     account (9a);
//   * delete: only an unused (no book, series or bundle), non-default pen
//     name, through the same writer, filtered by id AND author.

const PAGE = "/dashboard/pen-names";
const SAVE_ERROR = "We couldn't save this pen name. Please try again.";
const PHOTO_ERROR = "We couldn't save the photo. Please try again.";
const DELETE_ERROR = "We couldn't delete this pen name. Please try again.";
const IN_USE_MESSAGE = "This pen name is still used by a book, series or bundle, so it can't be deleted.";
// Same private staging area and key shape AvatarField uses.
const STAGING_BUCKET = "manuscripts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function fail(message: string): never {
  redirect(`${PAGE}?error=${encodeURIComponent(message)}`);
}

type OwnPenNameRow = { id: string; is_default: boolean; avatar_path: string | null };

async function requireOwnPenName(penNameId: string) {
  if (!UUID_PATTERN.test(penNameId)) fail(SAVE_ERROR);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${PAGE}`);

  const { data: row, error } = await supabase
    .from("pen_names")
    .select("id, is_default, avatar_path")
    .eq("id", penNameId)
    .eq("author_id", user.id)
    .maybeSingle<OwnPenNameRow>();
  if (error || !row) fail(SAVE_ERROR);
  return { supabase, user, row };
}

// The staged photo (AvatarField: "<uid>/tmp/avatar/<uuid>.<ext>" in the
// private staging bucket), re-validated here: size and real byte
// signature, never the client's word.
async function readStagedPhoto(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  tempPath: string,
) {
  if (!tempPath.startsWith(`${userId}/tmp/avatar/`) || !/\.(jpe?g|png)$/i.test(tempPath) || tempPath.includes("..")) {
    fail("That photo reference is no longer valid. Please choose your file again.");
  }
  const { data, error } = await supabase.storage.from(STAGING_BUCKET).download(tempPath);
  if (error || !data) {
    console.error("pen names: staged photo download failed:", error);
    fail("Could not read your uploaded photo. Please try again.");
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length > PEN_NAME_PHOTO_MAX_BYTES) fail("This image is larger than the 5 MB limit.");
  const kind = await detectCoverImageKind(
    new File([new Uint8Array(bytes)], "pen-name", { type: "application/octet-stream" }),
  );
  if (!kind) fail("That doesn't look like a valid JPEG or PNG image.");
  // COVERS-1: the stored photo is always the shrunk JPEG.
  const shrunk = await shrinkImageToJpeg(bytes, PEN_NAME_PHOTO_SIZE);
  if (!shrunk) fail("Could not read your uploaded photo. Please try again.");
  const { extension, contentType } = resolveVerifiedCoverStorageDetails("jpeg");
  return { bytes: shrunk, extension, contentType };
}

export async function updatePenName(penNameId: string, formData: FormData) {
  const { supabase, user, row } = await requireOwnPenName(penNameId);

  const name = parsePenNameName(formData.get("name"));
  if (!name.ok) fail(name.message);
  const bio = String(formData.get("bio") ?? "").trim();
  if (bio.length > PEN_NAME_BIO_MAX_LENGTH) {
    fail(`The bio must be ${PEN_NAME_BIO_MAX_LENGTH} characters or fewer.`);
  }
  const links = parsePenNameLinks(formData.getAll("links"));
  if (!links.ok) fail(links.message);

  const tempPhotoPath = String(formData.get("avatarStoragePath") ?? "").trim();
  const removePhoto = formData.get("removePhoto") === "on";
  const photo = tempPhotoPath ? await readStagedPhoto(supabase, user.id, tempPhotoPath) : null;

  const { data: written, error: updateError } = await supabase
    .from("pen_names")
    .update({ name: name.name, bio: bio === "" ? null : bio, links: links.links })
    .eq("id", row.id)
    .eq("author_id", user.id)
    .select("id");
  if (updateError) {
    // 23505: the (author, lower(name)) unique index -- another of this
    // author's pen names already has the name.
    if ((updateError as { code?: string }).code === "23505") fail(PEN_NAME_TAKEN_MESSAGE);
    console.error("updatePenName: update failed", { code: (updateError as { code?: string }).code ?? null });
    fail(penNameErrorMessage(updateError) ?? SAVE_ERROR);
  }
  if (!Array.isArray(written) || written.length !== 1) fail(SAVE_ERROR);

  const oldPhotoPath = row.avatar_path;
  let newPhotoPath: string | null | undefined;
  const writer = createPenNameWriteClient();
  if (photo) {
    newPhotoPath = canonicalPenNamePhotoPath(randomUUID(), photo.extension);
    const { error: uploadError } = await writer.storage
      .from(AVATARS_BUCKET)
      .upload(newPhotoPath, photo.bytes, {
        contentType: photo.contentType,
        cacheControl: IMAGE_CACHE_CONTROL_SECONDS,
        upsert: false,
      });
    if (uploadError) {
      console.error("updatePenName: photo upload failed:", uploadError);
      fail(PHOTO_ERROR);
    }
  } else if (removePhoto && oldPhotoPath !== null) {
    newPhotoPath = null;
  }

  if (newPhotoPath !== undefined) {
    const { data: photoRows, error: photoWriteError } = await writer
      .from("pen_names")
      .update({ avatar_path: newPhotoPath })
      .eq("id", row.id)
      .eq("author_id", user.id)
      .select("id, avatar_path");
    if (
      photoWriteError ||
      !Array.isArray(photoRows) ||
      photoRows.length !== 1 ||
      (photoRows[0] as { avatar_path: unknown }).avatar_path !== newPhotoPath
    ) {
      console.error("updatePenName: photo path write failed:", photoWriteError);
      if (newPhotoPath) {
        await writer.storage.from(AVATARS_BUCKET).remove([newPhotoPath]);
      }
      fail(PHOTO_ERROR);
    }
    // The superseded photo, only when it has exactly the canonical shape
    // (it came from this author's own row).
    if (oldPhotoPath !== null && isPenNamePhotoPath(oldPhotoPath) && oldPhotoPath !== newPhotoPath) {
      const { error: removeError } = await writer.storage.from(AVATARS_BUCKET).remove([oldPhotoPath]);
      if (removeError) console.error("updatePenName: old photo cleanup failed:", removeError);
    }
  }

  if (tempPhotoPath) {
    const { error: cleanupError } = await supabase.storage.from(STAGING_BUCKET).remove([tempPhotoPath]);
    if (cleanupError) console.error("updatePenName: staged photo cleanup failed:", cleanupError);
  }

  revalidatePath(PAGE);
  revalidatePath(authorPagePath(row.id));
  redirect(`${PAGE}?success=${encodeURIComponent("Pen name saved.")}`);
}

export async function deletePenName(penNameId: string) {
  const { supabase, user, row } = await requireOwnPenName(penNameId);
  if (row.is_default) fail("Your default pen name can't be deleted. It is your Public author name.");

  // "Unused" = no book (any status), series or bundle. The foreign keys
  // refuse deleting a used pen name anyway; this gives the clear message.
  const [books, series, bundles] = await Promise.all([
    supabase.from("books").select("id", { count: "exact", head: true }).eq("author_id", user.id).eq("pen_name_id", row.id),
    supabase.from("series").select("id", { count: "exact", head: true }).eq("author_id", user.id).eq("pen_name_id", row.id),
    supabase.from("bundles").select("id", { count: "exact", head: true }).eq("author_id", user.id).eq("pen_name_id", row.id),
  ]);
  if (books.error || series.error || bundles.error) fail(DELETE_ERROR);
  if ((books.count ?? 0) + (series.count ?? 0) + (bundles.count ?? 0) > 0) fail(IN_USE_MESSAGE);

  const writer = createPenNameWriteClient();
  const { data: deleted, error: deleteError } = await writer
    .from("pen_names")
    .delete()
    .eq("id", row.id)
    .eq("author_id", user.id)
    .eq("is_default", false)
    .select("id");
  if (deleteError) {
    console.error("deletePenName: delete failed", { code: (deleteError as { code?: string }).code ?? null });
    fail((deleteError as { code?: string }).code === "23503" ? IN_USE_MESSAGE : DELETE_ERROR);
  }
  if (!Array.isArray(deleted) || deleted.length !== 1) fail(DELETE_ERROR);

  if (row.avatar_path !== null && isPenNamePhotoPath(row.avatar_path)) {
    const { error: removeError } = await writer.storage.from(AVATARS_BUCKET).remove([row.avatar_path]);
    if (removeError) console.error("deletePenName: photo cleanup failed:", removeError);
  }

  revalidatePath(PAGE);
  redirect(`${PAGE}?success=${encodeURIComponent("Pen name deleted.")}`);
}
