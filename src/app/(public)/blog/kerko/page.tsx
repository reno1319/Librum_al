import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { BLOG_SEARCH_RESULT_LIMIT, parseBlogSearchQuery } from "@/lib/blog-search";
import type { BlogLandingCandidate } from "@/lib/blog-landing-logic";
import { BlogArticleCard } from "@/components/blog-article-card";
import { BlogSearchBox } from "@/components/blog-search-box";

// Blog search results (bs5/bs6, Renato 2026-11-17): /blog/kerko?q=...
// Blog posts only, never books. Matches title, excerpt and the hidden
// keywords (search_blog_posts(), accent- and case-blind, every word
// must match), newest first, up to 30. Results pages are not indexed
// by search engines (endless ?q= variants of the same posts).
export const metadata: Metadata = {
  title: "Kërko në blog",
  robots: { index: false, follow: true },
};

export default async function BlogSearchPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  const { display, term } = parseBlogSearchQuery((await searchParams).q);

  let posts: BlogLandingCandidate[] = [];
  const supabase = await createClient();
  if (term) {
    // Public/RLS-backed client only. The function returns ids in its own
    // order (newest first); the rows are read back through the normal
    // published-only select and put back in that order.
    const { data: hits } = await supabase.rpc("search_blog_posts", {
      search_term: term,
      result_limit: BLOG_SEARCH_RESULT_LIMIT,
    });
    const ids = ((hits ?? []) as { post_id: string }[]).map((h) => h.post_id);
    if (ids.length > 0) {
      const { data } = await supabase
        .from("blog_posts")
        .select("id, slug, title, excerpt, category, is_editorial, cover_image_path, published_at, status, featured")
        .eq("status", "published")
        .in("id", ids)
        .returns<BlogLandingCandidate[]>();
      const byId = new Map((data ?? []).map((p) => [p.id, p]));
      posts = ids.map((id) => byId.get(id)).filter((p): p is BlogLandingCandidate => !!p && p.status === "published");
    }
  }

  function coverUrlFor(path: string | null): string | null {
    return path ? supabase.storage.from("blog").getPublicUrl(path).data.publicUrl : null;
  }

  return (
    <main className="flex-1 pt-5 sm:pt-10">
      <div className="page-container pb-12">
        <Link href="/blog" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
          &larr; Blog
        </Link>
        <h1 className="mt-4 font-serif text-3xl font-normal text-foreground md:text-4xl">Kërko në blog</h1>

        <div className="mt-6">
          <BlogSearchBox defaultValue={display} />
        </div>

        {!term ? (
          <p className="mt-8 text-muted">Shkruani një fjalë për të kërkuar artikujt e blogut.</p>
        ) : posts.length === 0 ? (
          <div className="mt-8">
            <p className="text-foreground">Asnjë artikull nuk u gjet për «{display}».</p>
            <p className="mt-3">
              <Link href="/blog" className="text-sm text-primary underline underline-offset-[3px] hover:decoration-2">
                Kthehu te blogu
              </Link>
            </p>
          </div>
        ) : (
          <>
            <p className="mt-8 text-sm text-muted" aria-live="polite">
              {posts.length === 1 ? "1 artikull" : `${posts.length} artikuj`} për «{display}»
            </p>
            <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-8 lg:grid-cols-3">
              {posts.map((post) => (
                <BlogArticleCard
                  key={post.id}
                  compactOnMobile
                  post={{
                    slug: post.slug,
                    title: post.title,
                    excerpt: post.excerpt,
                    category: post.category,
                    is_editorial: post.is_editorial,
                    coverUrl: coverUrlFor(post.cover_image_path),
                    published_at: post.published_at,
                  }}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
