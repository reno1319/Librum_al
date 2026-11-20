"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireStaff } from "@/lib/staff";
import { ADMIN_LOGIN_PATH } from "@/lib/admin-safe-redirect";
import { EDITORIAL_VALUE } from "@/lib/blog-categories";
import { mapCategoryRpcError, readCategoryFields } from "./category-logic";

// Patch B (2026-11-19): owner and admin manage the blog categories.
// Every write goes through a SECURITY DEFINER RPC that re-checks
// staff_has_permission('blog.categories'); requireStaff() here only
// gives a clean redirect. redirect() stays outside every try/catch.

const LIST = "/admin/blog/categories";

function withQuery(path: string, key: "error" | "success", message: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}${key}=${encodeURIComponent(message)}`;
}

function editPath(value: string): string {
  return `${LIST}/${encodeURIComponent(value)}/edit`;
}

// Category names, colours and order show on every blog page.
function refreshBlog(): void {
  revalidatePath("/blog", "layout");
  revalidatePath("/admin/blog", "layout");
}

export async function createBlogCategoryAction(formData: FormData): Promise<void> {
  await requireStaff("blog.categories");
  const fields = readCategoryFields(formData, "new");
  if (!fields.ok) redirect(withQuery(`${LIST}/new`, "error", fields.error));

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_blog_category", {
    p_label: fields.value.label,
    p_short_label: fields.value.shortLabel,
    p_description: fields.value.description,
    p_url_slug: fields.value.urlSlug,
    p_colour: fields.value.colour,
    p_cta: fields.value.cta,
  });
  if (error?.message === "not authenticated") redirect(ADMIN_LOGIN_PATH);
  if (error) redirect(withQuery(`${LIST}/new`, "error", mapCategoryRpcError(error)));

  refreshBlog();
  redirect(withQuery(LIST, "success", "Category created. It is last in the order: move it with the arrows."));
}

export async function updateBlogCategoryAction(value: string, formData: FormData): Promise<void> {
  await requireStaff("blog.categories");
  const fields = readCategoryFields(formData, value === EDITORIAL_VALUE ? "editorial" : "edit");
  if (!fields.ok) redirect(withQuery(editPath(value), "error", fields.error));

  const supabase = await createClient();
  const { error } = await supabase.rpc("update_blog_category", {
    p_value: value,
    p_label: fields.value.label,
    p_short_label: fields.value.shortLabel,
    p_description: fields.value.description,
    p_colour: fields.value.colour,
    p_cta: fields.value.cta,
  });
  if (error?.message === "not authenticated") redirect(ADMIN_LOGIN_PATH);
  if (error) redirect(withQuery(editPath(value), "error", mapCategoryRpcError(error)));

  refreshBlog();
  redirect(withQuery(LIST, "success", "Category saved."));
}

export async function moveBlogCategoryAction(value: string, direction: "up" | "down"): Promise<void> {
  await requireStaff("blog.categories");
  const supabase = await createClient();
  const { error } = await supabase.rpc("move_blog_category", { p_value: value, p_direction: direction });
  if (error?.message === "not authenticated") redirect(ADMIN_LOGIN_PATH);
  if (error) redirect(withQuery(LIST, "error", mapCategoryRpcError(error)));

  refreshBlog();
  redirect(LIST);
}

export async function deleteBlogCategoryAction(value: string, formData: FormData): Promise<void> {
  await requireStaff("blog.categories");
  if (formData.get("confirm") !== "on") {
    redirect(withQuery(editPath(value), "error", "Tick the box to confirm the delete."));
  }
  const moveTo = formData.get("moveTo");

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("delete_blog_category", {
    p_value: value,
    p_move_to: typeof moveTo === "string" && moveTo !== "" ? moveTo : null,
  });
  if (error?.message === "not authenticated") redirect(ADMIN_LOGIN_PATH);
  if (error) redirect(withQuery(editPath(value), "error", mapCategoryRpcError(error)));

  refreshBlog();
  redirect(
    withQuery(
      LIST,
      "success",
      typeof data === "number" && data > 0 ? "Category deleted. Its articles were moved." : "Category deleted.",
    ),
  );
}
