import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";
import { BLOG_CATEGORY_COLUMNS, toBlogCategories, type BlogCategoryInfo, type BlogCategoryRow } from "./blog-categories";

// One read of blog_categories per request (React cache), through the
// ordinary request-scoped client: the table is public-readable (RLS
// select policy for everyone), writes only go through the RPCs.
// A failed read throws, so a page errors instead of quietly showing a
// blog with no categories.
export const getBlogCategories = cache(async (): Promise<BlogCategoryInfo[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("blog_categories")
    .select(BLOG_CATEGORY_COLUMNS)
    .order("sort_order", { ascending: true })
    .returns<BlogCategoryRow[]>();
  if (error) throw new Error(`blog categories could not be read: ${error.message}`);
  return toBlogCategories(data ?? []);
});
