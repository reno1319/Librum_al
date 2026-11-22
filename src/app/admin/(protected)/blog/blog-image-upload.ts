"use client";

import { createClient } from "@/lib/supabase/client";
import { uploadBlogInlineImageAction } from "./actions";

// Uploads a picture for the article body, the same way as before
// (e2, 2026-11-19): into the private staging area first, then the
// server shrinks it to a JPEG and moves it to the public blog pictures.
// The private staging area only takes JPG and PNG, so anything else
// (a WebP, or a cropped copy) is sent as a JPEG.
export async function uploadBlogPicture(
  staffUserId: string,
  picture: Blob,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const upload = picture.type === "image/jpeg" || picture.type === "image/png" ? picture : await toJpeg(picture);
  if (!upload) return { ok: false, error: "We couldn't add this image. Please try again." };
  const extension = upload.type === "image/png" ? "png" : "jpg";
  const tempPath = `${staffUserId}/tmp/blog/${crypto.randomUUID()}.${extension}`;
  const { error: uploadError } = await createClient()
    .storage.from("manuscripts")
    .upload(tempPath, upload, { contentType: upload.type });
  if (uploadError) {
    console.error("uploadBlogPicture: upload failed:", uploadError);
    return { ok: false, error: "We couldn't add this image. Please try again." };
  }
  return uploadBlogInlineImageAction(tempPath);
}

async function toJpeg(file: Blob): Promise<Blob | null> {
  const bitmap = await createImageBitmap(file);
  // Never wider than 2400 px, so the JPEG stays well under the limit
  // (the server shrinks it to 1400 px anyway).
  const scale = Math.min(1, 2400 / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
}
