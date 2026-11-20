import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getBlogCategories } from "@/lib/blog-categories-server";
import { isPostInSection, type BlogCategoryInfo } from "@/lib/blog-categories";

export type AdminCategory = BlogCategoryInfo & { articleCount: number };

// The categories in their set order, each with how many articles it
// holds (every status: drafts and scheduled count too, because a
// delete moves them as well). Staff read every post through RLS.
export async function loadAdminCategories(): Promise<AdminCategory[]> {
  const supabase = await createClient();
  const [categories, { data: posts, error }] = await Promise.all([
    getBlogCategories(),
    supabase.from("blog_posts").select("category, is_editorial").returns<{ category: string; is_editorial: boolean }[]>(),
  ]);
  if (error) throw new Error(`blog posts could not be read: ${error.message}`);
  const list = posts ?? [];
  return categories.map((c) => ({
    ...c,
    articleCount: list.filter((p) => isPostInSection(p, c.value)).length,
  }));
}
