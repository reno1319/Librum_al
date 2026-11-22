import { notFound, redirect } from "next/navigation";
import { requireStaff } from "@/lib/staff";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Dashboard batch 2: the staff bar's "Ndrysho" on a public article only
// knows the article's address, so this turns the address into the post's
// editor. Same gate as the editor itself (blog.manage); an unknown
// address is a 404.
export default async function OpenBlogPostBySlug({ params }: { params: Promise<{ slug: string }> }) {
  await requireStaff("blog.manage");
  const { slug } = await params;

  const supabase = await createClient();
  const { data: post } = await supabase
    .from("blog_posts")
    .select("id")
    .eq("slug", slug)
    .maybeSingle<{ id: string }>();

  if (!post) {
    notFound();
  }

  redirect(`/admin/blog/${post.id}/edit`);
}
