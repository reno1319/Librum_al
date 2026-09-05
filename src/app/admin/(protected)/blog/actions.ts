"use server";

import { randomUUID } from "crypto";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { ADMIN_LOGIN_PATH } from "@/lib/admin-safe-redirect";
import { detectCoverImageKind, resolveVerifiedCoverStorageDetails } from "@/lib/cover-image";
import {
  mapBlogRpcError,
  NOT_AUTHENTICATED_RPC_MESSAGE,
  validateBlogPostFields,
} from "./blog-form-logic";

// ============================================================
// BLOG-1B/BLOG-1B.1's approved security model, unchanged here:
// blog_posts carries no direct table-level INSERT/UPDATE/DELETE grant
// at all -- every mutation below goes through migration 047's own
// SECURITY DEFINER RPCs (create_blog_post/update_blog_post/
// publish_blog_post/unpublish_blog_post/delete_blog_post), never a raw
// `.from("blog_posts").insert/update/delete(...)`. requireStaff() here
// is defense in depth for a clean redirect experience, not the actual
// security boundary -- exactly the same relationship this codebase's
// existing reviewBookReport()/reviewRefundRequest() actions already
// have to their own RPCs (see reports/actions.ts's own comment); the
// RPC itself independently re-derives the caller's identity and
// re-checks staff_has_permission('blog.manage').
// ============================================================

const MAX_COVER_BYTES = 5 * 1024 * 1024;
const BLOG_BUCKET = "blog";
const STAGING_BUCKET = "manuscripts";

type ResolvedCover =
  | { present: false }
  | { present: true; bytes: Buffer; extension: "jpg" | "png"; contentType: "image/jpeg" | "image/png"; tempPathToCleanup: string };

// Mirrors resolveCoverInput() (src/app/(public)/dashboard/books/actions.ts)
// exactly: downloads the staged bytes from the PRIVATE manuscripts
// bucket and re-verifies the real byte signature server-side --
// tempPath's own "<uid>/tmp/blog/..." shape and ".jpg"/".png" extension
// are only a routing guard, never proof of real format. Returns
// `present: false` (not an error) when no cover was staged at all --
// the ordinary "keep the existing cover" / "no cover yet" case.
async function resolveStagedCoverInput(
  supabase: Awaited<ReturnType<typeof createClient>>,
  staffUserId: string,
  formData: FormData,
  errorRedirectPath: string,
): Promise<ResolvedCover> {
  const tempPath = String(formData.get("coverStoragePath") ?? "").trim();
  if (!tempPath) return { present: false };

  if (!tempPath.startsWith(`${staffUserId}/tmp/blog/`) || !/\.(jpe?g|png)$/i.test(tempPath)) {
    redirect(
      `${errorRedirectPath}?error=${encodeURIComponent("That cover reference is no longer valid. Please choose your file again.")}`,
    );
  }

  const { data, error: downloadError } = await supabase.storage
    .from(STAGING_BUCKET)
    .download(tempPath);
  if (downloadError || !data) {
    console.error("resolveStagedCoverInput: temp cover download failed:", downloadError);
    redirect(`${errorRedirectPath}?error=${encodeURIComponent("Could not read your uploaded cover. Please try again.")}`);
  }

  const bytes = Buffer.from(await data!.arrayBuffer());

  if (bytes.length > MAX_COVER_BYTES) {
    await supabase.storage.from(STAGING_BUCKET).remove([tempPath]);
    redirect(`${errorRedirectPath}?error=${encodeURIComponent("Cover image must be under 5MB")}`);
  }

  const coverFile = new File([new Uint8Array(bytes)], "cover", { type: "application/octet-stream" });
  const coverKind = await detectCoverImageKind(coverFile);
  if (!coverKind) {
    await supabase.storage.from(STAGING_BUCKET).remove([tempPath]);
    redirect(`${errorRedirectPath}?error=${encodeURIComponent("That doesn't look like a valid JPEG or PNG image")}`);
  }
  const { extension, contentType } = resolveVerifiedCoverStorageDetails(coverKind!);

  return { present: true, bytes, extension, contentType, tempPathToCleanup: tempPath };
}

// Recommended permanent path from the BLOG-1B design report:
// covers/<blog-post-id>/<uuid>.<ext>, inside the public "blog" bucket.
// Returns null (never throws) on upload failure so callers can decide
// their own fallback behavior per BLOG-1C's own failure-mode rules.
async function uploadPermanentCover(
  supabase: Awaited<ReturnType<typeof createClient>>,
  postId: string,
  bytes: Buffer,
  extension: "jpg" | "png",
  contentType: "image/jpeg" | "image/png",
): Promise<string | null> {
  const permanentPath = `covers/${postId}/${randomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from(BLOG_BUCKET)
    .upload(permanentPath, bytes, { contentType });
  if (error) {
    console.error("uploadPermanentCover: upload failed:", error);
    return null;
  }
  return permanentPath;
}

function fieldsFromFormData(formData: FormData) {
  return {
    title: String(formData.get("title") ?? ""),
    slug: String(formData.get("slug") ?? ""),
    excerpt: String(formData.get("excerpt") ?? ""),
    contentMarkdown: String(formData.get("contentMarkdown") ?? ""),
    category: String(formData.get("category") ?? ""),
    featured: formData.get("featured") === "on",
    seoTitle: String(formData.get("seoTitle") ?? ""),
    seoDescription: String(formData.get("seoDescription") ?? ""),
  };
}

// ============================================================
// createBlogPostAction: BLOG-1B's own "create draft first, cover
// second" sequence (Section 13 of the BLOG-1C brief) -- the post id
// does not exist until create_blog_post() returns one, so a staged
// cover can only be processed AFTER the draft is already safely saved.
// A cover-processing failure below never discards the draft; it
// redirects to the now-real edit page with a cover-specific error, so
// no DB/storage inconsistency is ever created for convenience.
// ============================================================
export async function createBlogPostAction(formData: FormData) {
  const { userId } = await requireStaff("blog.manage");
  const supabase = await createClient();

  const validation = validateBlogPostFields(fieldsFromFormData(formData));
  if (!validation.ok) {
    redirect(`/admin/blog/new?error=${encodeURIComponent(validation.error)}`);
  }

  const { data: newId, error: createError } = await supabase.rpc("create_blog_post", {
    p_title: validation.value.title,
    p_slug: validation.value.slug,
    p_excerpt: validation.value.excerpt,
    p_content_markdown: validation.value.contentMarkdown,
    p_cover_image_path: null,
    p_category: validation.value.category,
    p_featured: validation.value.featured,
    p_seo_title: validation.value.seoTitle,
    p_seo_description: validation.value.seoDescription,
  });

  if (createError) {
    if (createError.message === NOT_AUTHENTICATED_RPC_MESSAGE) {
      redirect(ADMIN_LOGIN_PATH);
    }
    redirect(`/admin/blog/new?error=${encodeURIComponent(mapBlogRpcError(createError))}`);
  }

  const postId = newId as string;

  const coverResult = await resolveStagedCoverInput(supabase, userId, formData, `/admin/blog/${postId}/edit`);
  if (coverResult.present) {
    const permanentPath = await uploadPermanentCover(
      supabase,
      postId,
      coverResult.bytes,
      coverResult.extension,
      coverResult.contentType,
    );

    if (!permanentPath) {
      revalidatePath("/admin/blog");
      redirect(
        `/admin/blog/${postId}/edit?error=${encodeURIComponent("Your article was created, but the cover image could not be uploaded. Please try again.")}`,
      );
    }

    const { error: updateError } = await supabase.rpc("update_blog_post", {
      p_id: postId,
      p_title: validation.value.title,
      p_slug: validation.value.slug,
      p_excerpt: validation.value.excerpt,
      p_content_markdown: validation.value.contentMarkdown,
      p_cover_image_path: permanentPath,
      p_category: validation.value.category,
      p_featured: validation.value.featured,
      p_seo_title: validation.value.seoTitle,
      p_seo_description: validation.value.seoDescription,
    });

    if (updateError) {
      // DB update failed after the permanent upload already succeeded --
      // clean up the now-orphaned permanent object; the draft itself
      // (with cover_image_path still null) remains intact either way.
      await supabase.storage.from(BLOG_BUCKET).remove([permanentPath]);
      await supabase.storage.from(STAGING_BUCKET).remove([coverResult.tempPathToCleanup]);
      revalidatePath("/admin/blog");
      redirect(
        `/admin/blog/${postId}/edit?error=${encodeURIComponent("Your article was created, but the cover image could not be saved. Please try uploading it again.")}`,
      );
    }

    await supabase.storage.from(STAGING_BUCKET).remove([coverResult.tempPathToCleanup]);
  }

  revalidatePath("/admin/blog");
  redirect(`/admin/blog/${postId}/edit`);
}

// ============================================================
// updateBlogPostAction: ordinary field edits, including cover
// replacement. Never touches status/published_at/created_by (not
// parameters to update_blog_post() at all). The old permanent cover is
// deleted only AFTER update_blog_post() itself succeeds -- if the
// upload succeeds but the DB update fails, the newly-uploaded object is
// removed and the old cover is left completely untouched.
// ============================================================
export async function updateBlogPostAction(postId: string, formData: FormData) {
  const { userId } = await requireStaff("blog.manage");
  const supabase = await createClient();

  const { data: existing } = await supabase
    .from("blog_posts")
    .select("id, cover_image_path")
    .eq("id", postId)
    .maybeSingle();

  if (!existing) {
    redirect(`/admin/blog?error=${encodeURIComponent("That article could not be found.")}`);
  }

  const validation = validateBlogPostFields(fieldsFromFormData(formData));
  if (!validation.ok) {
    redirect(`/admin/blog/${postId}/edit?error=${encodeURIComponent(validation.error)}`);
  }

  const coverResult = await resolveStagedCoverInput(supabase, userId, formData, `/admin/blog/${postId}/edit`);

  let coverImagePath = existing.cover_image_path as string | null;
  let newPermanentPathForCleanupOnFailure: string | null = null;

  if (coverResult.present) {
    const permanentPath = await uploadPermanentCover(
      supabase,
      postId,
      coverResult.bytes,
      coverResult.extension,
      coverResult.contentType,
    );

    if (!permanentPath) {
      redirect(
        `/admin/blog/${postId}/edit?error=${encodeURIComponent("The new cover image could not be uploaded. Your previous cover was kept.")}`,
      );
    }

    coverImagePath = permanentPath;
    newPermanentPathForCleanupOnFailure = permanentPath;
  }

  const { error: updateError } = await supabase.rpc("update_blog_post", {
    p_id: postId,
    p_title: validation.value.title,
    p_slug: validation.value.slug,
    p_excerpt: validation.value.excerpt,
    p_content_markdown: validation.value.contentMarkdown,
    p_cover_image_path: coverImagePath,
    p_category: validation.value.category,
    p_featured: validation.value.featured,
    p_seo_title: validation.value.seoTitle,
    p_seo_description: validation.value.seoDescription,
  });

  if (updateError) {
    if (updateError.message === NOT_AUTHENTICATED_RPC_MESSAGE) {
      redirect(ADMIN_LOGIN_PATH);
    }
    // Never delete the old cover before DB success -- the DB update
    // itself failed, so the row still points at the OLD cover (if any).
    // Only the newly-uploaded, now-orphaned permanent object (if this
    // was a cover replacement) is cleaned up; the temp staged object is
    // also removed since its bytes were already durably copied into the
    // (now-orphaned) permanent object above.
    if (newPermanentPathForCleanupOnFailure) {
      await supabase.storage.from(BLOG_BUCKET).remove([newPermanentPathForCleanupOnFailure]);
    }
    if (coverResult.present) {
      await supabase.storage.from(STAGING_BUCKET).remove([coverResult.tempPathToCleanup]);
    }
    redirect(`/admin/blog/${postId}/edit?error=${encodeURIComponent(mapBlogRpcError(updateError))}`);
  }

  // Only now, after the DB row is confirmed pointing at the new cover,
  // is it safe to remove the OLD permanent cover (if this was a
  // replacement, not a first-time cover) and the temp staged object.
  if (coverResult.present) {
    await supabase.storage.from(STAGING_BUCKET).remove([coverResult.tempPathToCleanup]);
    if (existing.cover_image_path && existing.cover_image_path !== coverImagePath) {
      const { error: removeOldError } = await supabase.storage
        .from(BLOG_BUCKET)
        .remove([existing.cover_image_path]);
      if (removeOldError) {
        console.error("updateBlogPostAction: failed to remove old cover:", removeOldError);
      }
    }
  }

  revalidatePath("/admin/blog");
  revalidatePath(`/admin/blog/${postId}/edit`);
  revalidatePath(`/admin/blog/${postId}/preview`);
  redirect(`/admin/blog/${postId}/edit?success=${encodeURIComponent("Article saved.")}`);
}

// ============================================================
// State-transition actions -- publish/unpublish/delete. Each calls
// exactly one RPC and trusts the DB transaction entirely: no duplicate
// audit-log write happens here (migration 047's own RPCs already write
// admin_audit_log in the same transaction as the state change), and
// published_at is never touched from application code.
// ============================================================
export async function publishBlogPostAction(postId: string) {
  await requireStaff("blog.manage");
  const supabase = await createClient();

  const { error } = await supabase.rpc("publish_blog_post", { p_id: postId });

  if (error) {
    if (error.message === NOT_AUTHENTICATED_RPC_MESSAGE) redirect(ADMIN_LOGIN_PATH);
    redirect(`/admin/blog/${postId}/edit?error=${encodeURIComponent(mapBlogRpcError(error))}`);
  }

  revalidatePath("/admin/blog");
  revalidatePath(`/admin/blog/${postId}/edit`);
  revalidatePath(`/admin/blog/${postId}/preview`);
  redirect(`/admin/blog/${postId}/edit?success=${encodeURIComponent("Article published.")}`);
}

export async function unpublishBlogPostAction(postId: string) {
  await requireStaff("blog.manage");
  const supabase = await createClient();

  const { error } = await supabase.rpc("unpublish_blog_post", { p_id: postId });

  if (error) {
    if (error.message === NOT_AUTHENTICATED_RPC_MESSAGE) redirect(ADMIN_LOGIN_PATH);
    redirect(`/admin/blog/${postId}/edit?error=${encodeURIComponent(mapBlogRpcError(error))}`);
  }

  revalidatePath("/admin/blog");
  revalidatePath(`/admin/blog/${postId}/edit`);
  revalidatePath(`/admin/blog/${postId}/preview`);
  redirect(
    `/admin/blog/${postId}/edit?success=${encodeURIComponent("Article unpublished. It will no longer be visible on the public Blog once BLOG-1D ships.")}`,
  );
}

// Deletes a draft, then cleans up its permanent cover from storage
// using the RPC's own returned deleted_cover_image_path -- never a
// second, potentially-stale SELECT against a row that no longer
// exists. Storage-deletion failure is logged, not surfaced: the DB
// deletion is already authoritative and final by that point, and the
// post is never resurrected to "retry" a storage cleanup.
export async function deleteBlogPostAction(postId: string) {
  await requireStaff("blog.manage");
  const supabase = await createClient();

  const { data, error } = await supabase.rpc("delete_blog_post", { p_id: postId });

  if (error) {
    if (error.message === NOT_AUTHENTICATED_RPC_MESSAGE) redirect(ADMIN_LOGIN_PATH);
    redirect(`/admin/blog/${postId}/edit?error=${encodeURIComponent(mapBlogRpcError(error))}`);
  }

  const deletedCoverImagePath = Array.isArray(data) ? data[0]?.deleted_cover_image_path : null;
  if (deletedCoverImagePath) {
    const { error: removeError } = await supabase.storage.from(BLOG_BUCKET).remove([deletedCoverImagePath]);
    if (removeError) {
      console.error("deleteBlogPostAction: failed to remove cover for deleted post:", removeError);
    }
  }

  revalidatePath("/admin/blog");
  redirect(`/admin/blog?success=${encodeURIComponent("Draft deleted.")}`);
}
