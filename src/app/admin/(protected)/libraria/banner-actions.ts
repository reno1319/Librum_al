"use server";

import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireStaff } from "@/lib/staff";
import { detectCoverImageKind } from "@/lib/cover-image";
import { IMAGE_CACHE_CONTROL_SECONDS, shrinkImageToJpeg } from "@/lib/cover-resize";
import { checkStagedUploadSize } from "@/lib/staged-upload-size";
import {
  MAX_SLIDE_PICTURE_BYTES,
  SLIDE_PHONE_PICTURE_SIZE,
  SLIDE_PICTURE_SIZE,
  SLIDE_STAGING_BUCKET,
  isOwnStagedSlidePicturePath,
  isSlidePicturePath,
  parseSlideForm,
  type SlideFormProblem,
} from "@/lib/libraria-banner";

// LR1 patch 3 (Renato 2026-11-25): staff add, edit, move and delete the
// Libraria banner slides. requireStaff("catalog.feature") (owner and
// admin) runs first; the database functions check the permission again,
// refuse a book Libraria does not list (LB539) or a 7th slide on any day
// (LB538, lr3-7 a), and write the audit rows. Pictures (JPG or PNG under
// 5 MB, checked by their bytes) are shrunk to a JPEG and stored in the
// public "libraria" bucket by the service role, at a fresh
// slides/<uuid>.jpg; the bucket has no storage policies. A picture that
// a refused save uploaded, or that a save or delete replaced, is removed
// again (best effort: a failed removal only leaves an unused file).
//
// Banner two-pictures fix (Renato 2026-11-26): the pictures no longer
// come inside the form. Both together could pass Vercel's ~4.5 MB
// request limit, which refused the save before this code ran. The
// browser (slide-save-button.tsx) puts each picture in the private
// staging bucket first; the form carries only "pictureStoragePath" and
// "phonePictureStoragePath". Every way out of the save removes those
// waiting files again.
const PAGE_PATH = "/admin/libraria";
const BUCKET = "libraria";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SLIDE_SAVED = "Slide saved.";
const SLIDE_DELETED = "Slide deleted.";
const SLIDE_MOVED = "Slide moved.";
const NO_SLIDE = "That slide no longer exists.";
const CHOOSE_BOOK = "Choose a book.";
const DESCRIPTION_EMPTY = "Write the one-line description.";
const DESCRIPTION_LINES = "Keep the description on one line.";
const DESCRIPTION_LONG = "The description can be at most 120 characters.";
const TAG_LINES = "Keep the tag on one line.";
const TAG_LONG = "The tag can be at most 24 characters.";
const DAYS = "Enter the days as dates.";
const DAYS_ORDER = "The last day can’t be before the first day.";
const CHOOSE_PICTURE = "Choose a picture.";
const BAD_PICTURE = "Each picture must be a JPG or PNG under 5 MB.";
const UNREADABLE_PICTURE = "Couldn’t read that picture. Please choose another.";
const TOO_MANY = "At most 6 slides can show on the same day. Change the days or delete a slide.";
const BOOK_NOT_LISTED = "That book is not on Libraria now.";
const SAVE_FAILED = "Couldn’t save the slide. Please try again.";
const DELETE_FAILED = "Couldn’t delete the slide. Please try again.";
const MOVE_FAILED = "Couldn’t move the slide. Please try again.";

function problemMessage(problem: SlideFormProblem): string {
  switch (problem) {
    case "slide":
      return NO_SLIDE;
    case "book":
      return CHOOSE_BOOK;
    case "description_empty":
      return DESCRIPTION_EMPTY;
    case "description_lines":
      return DESCRIPTION_LINES;
    case "description_long":
      return DESCRIPTION_LONG;
    case "tag_lines":
      return TAG_LINES;
    case "tag_long":
      return TAG_LONG;
    case "days":
      return DAYS;
    case "days_order":
      return DAYS_ORDER;
  }
}

function withQuery(path: string, key: "error" | "success", message: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`;
}

// Back to the form that was open: the edit form keeps its ?edit=.
function formPath(slideId: string | null): string {
  return slideId ? `${PAGE_PATH}?edit=${slideId}` : PAGE_PATH;
}

type ServerClient = Awaited<ReturnType<typeof createClient>>;

// The waiting file's name, or null when this picture was not changed.
// A name that is not the caller's own exact staging shape is refused.
type StagedName = { ok: true; path: string | null } | { ok: false };

function stagedName(formData: FormData, name: string, userId: string): StagedName {
  const value = String(formData.get(name) ?? "").trim();
  if (!value) return { ok: true, path: null };
  return isOwnStagedSlidePicturePath(value, userId) ? { ok: true, path: value } : { ok: false };
}

type PictureResult = { ok: true; bytes: Buffer } | { ok: false; unreadable: boolean };

async function preparePicture(supabase: ServerClient, path: string, size: { width: number }): Promise<PictureResult> {
  const bucket = supabase.storage.from(SLIDE_STAGING_BUCKET);
  // Refuse an oversized file before reading it (the staging bucket takes
  // up to 50 MB).
  if ((await checkStagedUploadSize(bucket, path, MAX_SLIDE_PICTURE_BYTES)) === "too_large") {
    return { ok: false, unreadable: false };
  }
  const { data, error } = await bucket.download(path);
  if (error || !data) {
    console.error("Libraria banner: staged picture read failed:", error);
    return { ok: false, unreadable: true };
  }
  const bytes = Buffer.from(await data.arrayBuffer());
  const file = new File([new Uint8Array(bytes)], "picture", { type: "application/octet-stream" });
  if (bytes.length > MAX_SLIDE_PICTURE_BYTES || !(await detectCoverImageKind(file))) {
    return { ok: false, unreadable: false };
  }
  const shrunk = await shrinkImageToJpeg(bytes, size);
  return shrunk ? { ok: true, bytes: shrunk } : { ok: false, unreadable: true };
}

// Best effort, with the staff member's own session (the bucket lets a
// signed-in user remove only their own "<uid>/tmp/" files).
async function removeStaged(supabase: ServerClient, paths: (string | null)[]): Promise<void> {
  const list = paths.filter((p): p is string => typeof p === "string");
  if (list.length === 0) return;
  const { error } = await supabase.storage.from(SLIDE_STAGING_BUCKET).remove(list);
  if (error) console.error("Libraria banner: staged picture removal failed:", error);
}

async function uploadPicture(bytes: Buffer): Promise<string | null> {
  const path = `slides/${randomUUID()}.jpg`;
  const { error } = await createAdminClient()
    .storage.from(BUCKET)
    .upload(path, bytes, { contentType: "image/jpeg", cacheControl: IMAGE_CACHE_CONTROL_SECONDS });
  if (error) {
    console.error("Libraria banner: picture upload failed:", error);
    return null;
  }
  return path;
}

async function removePictures(paths: (string | null | undefined)[]): Promise<void> {
  const list = paths.filter((p): p is string => typeof p === "string" && isSlidePicturePath(p));
  if (list.length === 0) return;
  const { error } = await createAdminClient().storage.from(BUCKET).remove(list);
  if (error) console.error("Libraria banner: picture removal failed:", error);
}

type StoredPaths = { image_path: string; phone_image_path: string | null };

async function readStoredPaths(slideId: string): Promise<StoredPaths | null | "error"> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("libraria_banner_slides")
    .select("image_path, phone_image_path")
    .eq("id", slideId)
    .maybeSingle<StoredPaths>();
  if (error) {
    console.error("Libraria banner: slide read failed:", error);
    return "error";
  }
  return data ?? null;
}

function revalidate(): void {
  revalidatePath(PAGE_PATH);
  revalidatePath("/librari");
}

export async function saveBannerSlide(formData: FormData) {
  const { userId } = await requireStaff("catalog.feature");

  const wideName = stagedName(formData, "pictureStoragePath", userId);
  const phoneName = stagedName(formData, "phonePictureStoragePath", userId);
  const staged = [wideName.ok ? wideName.path : null, phoneName.ok ? phoneName.path : null];
  const supabase = await createClient();
  try {
    await saveSlide(formData, supabase, wideName, phoneName);
  } finally {
    await removeStaged(supabase, staged);
  }
}

async function saveSlide(formData: FormData, supabase: ServerClient, wideName: StagedName, phoneName: StagedName) {
  const parsed = parseSlideForm(formData);
  if (!parsed.ok) redirect(withQuery(formPath(null), "error", problemMessage(parsed.reason)));
  const { slideId } = parsed;

  if (!wideName.ok || !phoneName.ok) redirect(withQuery(formPath(slideId), "error", UNREADABLE_PICTURE));
  const picture = wideName.path;
  const phonePicture = phoneName.path;

  let stored: StoredPaths | null = null;
  if (slideId) {
    const read = await readStoredPaths(slideId);
    if (read === "error") redirect(withQuery(formPath(slideId), "error", SAVE_FAILED));
    if (read === null) redirect(withQuery(formPath(null), "error", NO_SLIDE));
    stored = read;
  } else if (!picture) {
    redirect(withQuery(formPath(null), "error", CHOOSE_PICTURE));
  }

  const wide = picture ? await preparePicture(supabase, picture, SLIDE_PICTURE_SIZE) : null;
  if (wide && !wide.ok) redirect(withQuery(formPath(slideId), "error", wide.unreadable ? UNREADABLE_PICTURE : BAD_PICTURE));
  const phone = phonePicture ? await preparePicture(supabase, phonePicture, SLIDE_PHONE_PICTURE_SIZE) : null;
  if (phone && !phone.ok) redirect(withQuery(formPath(slideId), "error", phone.unreadable ? UNREADABLE_PICTURE : BAD_PICTURE));

  const newWide = wide?.ok ? await uploadPicture(wide.bytes) : null;
  const newPhone = phone?.ok ? await uploadPicture(phone.bytes) : null;
  if ((wide?.ok && !newWide) || (phone?.ok && !newPhone)) {
    await removePictures([newWide, newPhone]);
    redirect(withQuery(formPath(slideId), "error", SAVE_FAILED));
  }

  const imagePath = newWide ?? stored?.image_path ?? null;
  const phonePath = newPhone ?? (parsed.removePhonePicture ? null : (stored?.phone_image_path ?? null));
  if (!imagePath) redirect(withQuery(formPath(slideId), "error", CHOOSE_PICTURE));

  const { data, error } = await supabase.rpc("staff_save_libraria_banner_slide", {
    p_id: slideId,
    p_book_id: parsed.bookId,
    p_description: parsed.description,
    p_tag: parsed.tag,
    p_image_path: imagePath,
    p_phone_image_path: phonePath,
    p_starts_on: parsed.startsOn,
    p_ends_on: parsed.endsOn,
  });
  if (error || !data) {
    await removePictures([newWide, newPhone]);
    if (error?.code === "LB538") redirect(withQuery(formPath(slideId), "error", TOO_MANY));
    if (error?.code === "LB539") redirect(withQuery(formPath(slideId), "error", BOOK_NOT_LISTED));
    if (!error) redirect(withQuery(formPath(null), "error", NO_SLIDE));
    console.error("saveBannerSlide: staff_save_libraria_banner_slide failed:", error);
    redirect(withQuery(formPath(slideId), "error", SAVE_FAILED));
  }

  // The old pictures this save replaced or removed.
  if (stored) {
    await removePictures([
      stored.image_path !== imagePath ? stored.image_path : null,
      stored.phone_image_path && stored.phone_image_path !== phonePath ? stored.phone_image_path : null,
    ]);
  }

  revalidate();
  redirect(`${PAGE_PATH}?success=${encodeURIComponent(SLIDE_SAVED)}#banner-slides`);
}

export async function deleteBannerSlide(formData: FormData) {
  await requireStaff("catalog.feature");

  const slideId = String(formData.get("slideId") ?? "");
  if (!UUID.test(slideId)) redirect(`${PAGE_PATH}?error=${encodeURIComponent(NO_SLIDE)}#banner-slides`);

  const stored = await readStoredPaths(slideId);
  if (stored === "error") redirect(`${PAGE_PATH}?error=${encodeURIComponent(DELETE_FAILED)}#banner-slides`);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("staff_delete_libraria_banner_slide", { p_id: slideId });
  if (error) {
    console.error("deleteBannerSlide: staff_delete_libraria_banner_slide failed:", error);
    redirect(`${PAGE_PATH}?error=${encodeURIComponent(DELETE_FAILED)}#banner-slides`);
  }
  if (data !== true) redirect(`${PAGE_PATH}?error=${encodeURIComponent(NO_SLIDE)}#banner-slides`);

  if (stored) await removePictures([stored.image_path, stored.phone_image_path]);
  revalidate();
  redirect(`${PAGE_PATH}?success=${encodeURIComponent(SLIDE_DELETED)}#banner-slides`);
}

export async function moveBannerSlide(formData: FormData) {
  await requireStaff("catalog.feature");

  const slideId = String(formData.get("slideId") ?? "");
  const direction = formData.get("direction");
  if (!UUID.test(slideId) || (direction !== "up" && direction !== "down")) {
    redirect(`${PAGE_PATH}?error=${encodeURIComponent(MOVE_FAILED)}#banner-slides`);
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("staff_move_libraria_banner_slide", {
    p_id: slideId,
    p_up: direction === "up",
  });
  if (error) {
    console.error("moveBannerSlide: staff_move_libraria_banner_slide failed:", error);
    redirect(`${PAGE_PATH}?error=${encodeURIComponent(MOVE_FAILED)}#banner-slides`);
  }

  // false = already first or last, or gone: nothing moved, nothing to say.
  revalidate();
  redirect(`${PAGE_PATH}?success=${encodeURIComponent(SLIDE_MOVED)}#banner-slides`);
}
