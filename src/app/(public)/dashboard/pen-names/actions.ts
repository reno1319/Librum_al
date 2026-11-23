"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { groupAllDigits } from "@/lib/catalog-price";
import { detectCoverImageKind, resolveVerifiedCoverStorageDetails } from "@/lib/cover-image";
import { IMAGE_CACHE_CONTROL_SECONDS, PEN_NAME_PHOTO_SIZE, shrinkImageToJpeg } from "@/lib/cover-resize";
import { AVATARS_BUCKET } from "@/lib/avatar-path";
import { createPenNameWriteClient, resolveOwnPenNameId } from "@/lib/pen-name-write-client";
import { canonicalPenNamePhotoPath, isPenNamePhotoPath } from "@/lib/pen-name-photo-path";
import { ACCOUNT_NAME_MAX_LENGTH, ACCOUNT_NAME_TOO_LONG_MESSAGE } from "@/lib/account-name";
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
//     name, through the same writer, filtered by id AND author;
//   * create (AUTHOR PROFILI build 1, "+ Shto pseudonim"): the same
//     resolveOwnPenNameId path the per-book pen name box uses.
//
// AUTHOR PROFILI (build 1): these forms live on Dashboard > Profili now;
// /dashboard/pen-names only redirects there.

const PAGE = "/dashboard/profile";
const SAVE_ERROR = "Pseudonimi nuk u ruajt dot. Provoni përsëri.";
const PHOTO_ERROR = "Fotoja nuk u ruajt dot. Provoni përsëri.";
const PROFILE_SAVE_ERROR = "Profili nuk u ruajt dot. Provoni përsëri.";
const CREATE_ERROR = "Pseudonimi nuk u shtua dot. Provoni përsëri.";
const DELETE_ERROR = "Pseudonimi nuk u fshi dot. Provoni përsëri.";
const IN_USE_MESSAGE = "Ky pseudonim përdoret ende nga një libër, seri ose paketë, ndaj nuk mund të fshihet.";
// Same private staging area and key shape AvatarField uses.
const STAGING_BUCKET = "manuscripts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// BUILD 2a-2: a publishing house's Autorët tab uses these same actions.
// Its forms send from=authors; then the action comes back to Autorët
// and its messages say "autor" instead of "pseudonim". Nothing else
// changes (the field only picks the page and the words, never the row).
const AUTHORS_PAGE = "/dashboard/authors";
const HOUSE_AUTHOR_ERRORS: Readonly<Record<string, string>> = {
  [SAVE_ERROR]: "Autori nuk u ruajt dot. Provoni përsëri.",
  [CREATE_ERROR]: "Autori nuk u shtua dot. Provoni përsëri.",
  [DELETE_ERROR]: "Autori nuk u hoq dot. Provoni përsëri.",
  [IN_USE_MESSAGE]: "Ky autor ka ende një libër, seri ose paketë, ndaj nuk mund të hiqet.",
  [PEN_NAME_TAKEN_MESSAGE]: "Këtë emër e ka tashmë një nga autorët tuaj ose shtëpia juaj botuese. Zgjidhni një emër tjetër.",
  "Pseudonimi nuk mund të jetë bosh.": "Emri i autorit nuk mund të jetë bosh.",
  "Pseudonimi mund të ketë deri në 120 karaktere.": "Emri i autorit mund të ketë deri në 120 karaktere.",
};
const HOUSE_AUTHOR_SUCCESSES: Readonly<Record<string, string>> = {
  "Pseudonimi u ruajt.": "Autori u ruajt.",
  "Pseudonimi u shtua.": "Autori u shtua.",
  "Pseudonimi u fshi.": "Autori u hoq.",
};

type Back = { page: string; authors: boolean };
const PROFILE_BACK: Back = { page: PAGE, authors: false };

function backFrom(formData: FormData | undefined): Back {
  return formData?.get("from") === "authors" ? { page: AUTHORS_PAGE, authors: true } : PROFILE_BACK;
}

function fail(message: string, back: Back = PROFILE_BACK): never {
  const text = back.authors ? (HOUSE_AUTHOR_ERRORS[message] ?? message) : message;
  redirect(`${back.page}?error=${encodeURIComponent(text)}`);
}

function succeed(message: string, back: Back): never {
  const text = back.authors ? (HOUSE_AUTHOR_SUCCESSES[message] ?? message) : message;
  revalidatePath(back.page);
  redirect(`${back.page}?success=${encodeURIComponent(text)}`);
}

type OwnPenNameRow = { id: string; is_default: boolean; avatar_path: string | null };

async function requireOwnPenName(penNameId: string, back: Back) {
  if (!UUID_PATTERN.test(penNameId)) fail(SAVE_ERROR, back);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${back.page}`);

  const { data: row, error } = await supabase
    .from("pen_names")
    .select("id, is_default, avatar_path")
    .eq("id", penNameId)
    .eq("author_id", user.id)
    .maybeSingle<OwnPenNameRow>();
  if (error || !row) fail(SAVE_ERROR, back);
  return { supabase, user, row };
}

// The staged photo (AvatarField: "<uid>/tmp/avatar/<uuid>.<ext>" in the
// private staging bucket), re-validated here: size and real byte
// signature, never the client's word.
async function readStagedPhoto(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  tempPath: string,
  back: Back,
) {
  if (!tempPath.startsWith(`${userId}/tmp/avatar/`) || !/\.(jpe?g|png)$/i.test(tempPath) || tempPath.includes("..")) {
    fail("Kjo foto nuk është më e vlefshme. Zgjidheni skedarin përsëri.", back);
  }
  const { data, error } = await supabase.storage.from(STAGING_BUCKET).download(tempPath);
  if (error || !data) {
    console.error("pen names: staged photo download failed:", error);
    fail("Fotoja e ngarkuar ka skaduar ose nuk u lexua dot. Zgjidheni përsëri.", back);
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  if (bytes.length > PEN_NAME_PHOTO_MAX_BYTES) fail("Ky imazh e kalon kufirin prej 5 MB.", back);
  const kind = await detectCoverImageKind(
    new File([new Uint8Array(bytes)], "pen-name", { type: "application/octet-stream" }),
  );
  if (!kind) fail("Ky nuk duket si imazh i vlefshëm JPEG ose PNG.", back);
  // COVERS-1: the stored photo is always the shrunk JPEG.
  const shrunk = await shrinkImageToJpeg(bytes, PEN_NAME_PHOTO_SIZE);
  if (!shrunk) fail("Fotoja e ngarkuar nuk u lexua dot. Provoni përsëri.", back);
  const { extension, contentType } = resolveVerifiedCoverStorageDetails("jpeg");
  return { bytes: shrunk, extension, contentType };
}

export async function updatePenName(penNameId: string, formData: FormData) {
  const back = backFrom(formData);
  const { supabase, user, row } = await requireOwnPenName(penNameId, back);

  const name = parsePenNameName(formData.get("name"));
  if (!name.ok) fail(name.message, back);
  const bio = String(formData.get("bio") ?? "").trim();
  if (bio.length > PEN_NAME_BIO_MAX_LENGTH) {
    fail(`Biografia mund të ketë deri në ${groupAllDigits(PEN_NAME_BIO_MAX_LENGTH)} karaktere.`, back);
  }
  const links = parsePenNameLinks(formData.getAll("links"));
  if (!links.ok) fail(links.message, back);

  // AUTHOR PROFILI (build 1, Renato's Q1 b): on Profili the main card's
  // one Ruani also saves the account name, which sits above the card.
  // Only the default pen name's form carries it. It is checked with
  // everything else before any write, and written first, on the session
  // client, to exactly the caller's own row (display_name only: the
  // author name is this pen name's own name, synced to the profile by
  // the database).
  let displayName: string | null = null;
  if (row.is_default && formData.has("displayName")) {
    displayName = String(formData.get("displayName") ?? "").trim();
    if (!displayName) fail("Emri nuk mund të jetë bosh", back);
    if (displayName.length > ACCOUNT_NAME_MAX_LENGTH) fail(ACCOUNT_NAME_TOO_LONG_MESSAGE, back);
  } else if (row.is_default) {
    // BUILD 2a-2 (Renato's k2 a): a publishing house's Profili has no
    // account name field; saving the house name saves it as the account
    // name too, so the greeting never keeps an old name. The kind is read
    // from the caller's own row, never taken from the form.
    const { data: kindRow, error: kindError } = await supabase
      .from("profiles")
      .select("account_kind")
      .eq("id", user.id)
      .single<{ account_kind: string | null }>();
    if (kindError || !kindRow) fail(PROFILE_SAVE_ERROR, back);
    if (kindRow.account_kind === "publishing_house") displayName = name.name;
  }

  const tempPhotoPath = String(formData.get("avatarStoragePath") ?? "").trim();
  const removePhoto = formData.get("removePhoto") === "on";
  const photo = tempPhotoPath ? await readStagedPhoto(supabase, user.id, tempPhotoPath, back) : null;

  if (displayName !== null) {
    const { data: profileRows, error: profileError } = await supabase
      .from("profiles")
      .update({ display_name: displayName })
      .eq("id", user.id)
      .select("id");
    if (
      profileError ||
      !Array.isArray(profileRows) ||
      profileRows.length !== 1 ||
      (profileRows[0] as { id?: unknown }).id !== user.id
    ) {
      console.error("updatePenName: account name update failed", {
        code: (profileError as { code?: string } | null)?.code ?? null,
      });
      fail(PROFILE_SAVE_ERROR, back);
    }
  }

  const { data: written, error: updateError } = await supabase
    .from("pen_names")
    .update({ name: name.name, bio: bio === "" ? null : bio, links: links.links })
    .eq("id", row.id)
    .eq("author_id", user.id)
    .select("id");
  if (updateError) {
    // 23505: the (author, lower(name)) unique index -- another of this
    // author's pen names already has the name.
    if ((updateError as { code?: string }).code === "23505") fail(PEN_NAME_TAKEN_MESSAGE, back);
    console.error("updatePenName: update failed", { code: (updateError as { code?: string }).code ?? null });
    fail(penNameErrorMessage(updateError) ?? SAVE_ERROR, back);
  }
  if (!Array.isArray(written) || written.length !== 1) fail(SAVE_ERROR, back);

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
      fail(PHOTO_ERROR, back);
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
      fail(PHOTO_ERROR, back);
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

  if (displayName !== null) revalidatePath("/", "layout");
  revalidatePath(authorPagePath(row.id));
  succeed(row.is_default ? "Profili u ruajt." : "Pseudonimi u ruajt.", back);
}

export async function deletePenName(penNameId: string, formData?: FormData) {
  const back = backFrom(formData);
  const { supabase, user, row } = await requireOwnPenName(penNameId, back);
  if (row.is_default) fail("Pseudonimi kryesor nuk mund të fshihet. Është emri juaj publik i autorit.", back);

  // "Unused" = no book (any status), series or bundle. The foreign keys
  // refuse deleting a used pen name anyway; this gives the clear message.
  const [books, series, bundles] = await Promise.all([
    supabase.from("books").select("id", { count: "exact", head: true }).eq("author_id", user.id).eq("pen_name_id", row.id),
    supabase.from("series").select("id", { count: "exact", head: true }).eq("author_id", user.id).eq("pen_name_id", row.id),
    supabase.from("bundles").select("id", { count: "exact", head: true }).eq("author_id", user.id).eq("pen_name_id", row.id),
  ]);
  if (books.error || series.error || bundles.error) fail(DELETE_ERROR, back);
  if ((books.count ?? 0) + (series.count ?? 0) + (bundles.count ?? 0) > 0) fail(IN_USE_MESSAGE, back);

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
    fail((deleteError as { code?: string }).code === "23503" ? IN_USE_MESSAGE : DELETE_ERROR, back);
  }
  if (!Array.isArray(deleted) || deleted.length !== 1) fail(DELETE_ERROR, back);

  if (row.avatar_path !== null && isPenNamePhotoPath(row.avatar_path)) {
    const { error: removeError } = await writer.storage.from(AVATARS_BUCKET).remove([row.avatar_path]);
    if (removeError) console.error("deletePenName: photo cleanup failed:", removeError);
  }

  succeed("Pseudonimi u fshi.", back);
}

// AUTHOR PROFILI (build 1): "+ Shto pseudonim". The name follows the
// per-book box's rules (parsePenNameName); the session author is the only
// author passed. resolve_author_pen_name returns an existing pen name for
// a name the author already uses (any case), so a returned id that was
// already one of theirs means "taken", never a second pen name.
export async function createPenName(formData: FormData) {
  const back = backFrom(formData);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${back.page}`);

  const name = parsePenNameName(formData.get("name"));
  if (!name.ok) fail(name.message, back);

  const [{ data: profile }, { data: existing, error: existingError }] = await Promise.all([
    supabase.from("profiles").select("role").eq("id", user.id).single<{ role: string }>(),
    supabase.from("pen_names").select("id").eq("author_id", user.id).returns<{ id: string }[]>(),
  ]);
  if (profile?.role !== "author" || existingError || !Array.isArray(existing)) fail(CREATE_ERROR, back);

  const result = await resolveOwnPenNameId(user.id, name.name);
  if (!result.ok) fail(result.reason === "invalid" ? result.message : CREATE_ERROR, back);
  if (existing.some((row) => row.id === result.penNameId)) fail(PEN_NAME_TAKEN_MESSAGE, back);

  succeed("Pseudonimi u shtua.", back);
}
