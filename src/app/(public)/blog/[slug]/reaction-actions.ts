"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { isBlogReaction } from "@/lib/blog-reactions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// BR1: turns one reaction on or off for the signed-in reader. The
// database (RLS + the toggle function) decides whether the article is
// live and whether the reader is allowed; this only shapes the call.
export async function toggleBlogReaction(postId: string, slug: string, reaction: string) {
  if (!UUID.test(postId) || !SLUG.test(slug) || !isBlogReaction(reaction)) redirect("/blog");
  const back = `/blog/${slug}`;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(back)}`);

  const { error } = await supabase.rpc("toggle_blog_post_reaction", {
    p_post_id: postId,
    p_reaction: reaction,
  });
  if (error) redirect(`${back}?error=${encodeURIComponent("Diçka shkoi keq. Provoni përsëri.")}#reagime`);

  revalidatePath(back);
  redirect(`${back}#reagime`);
}
