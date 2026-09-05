import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { resolveSiteOrigin } from "@/lib/site-url";
import { BLOG_CATEGORIES, BLOG_CATEGORY_LABELS_SQ } from "@/lib/blog-categories";
import {
  BLOG_LANDING_CANDIDATE_LIMIT,
  isBlogLandingEmpty,
  selectCategoryPosts,
  selectFeaturedPost,
  selectLatestPosts,
  type BlogLandingCandidate,
} from "@/lib/blog-landing-logic";
import { BlogArticleCard, type BlogArticleCardPost } from "@/components/blog-article-card";
import { EmptyState } from "@/components/ui/empty-state";

// LIBRUM 2.0 BLOG-1D: static metadata -- no per-request DB call is
// needed to describe the /blog index itself, unlike the article page's
// own generateMetadata() (which genuinely depends on a fetched row).
// canonical is the first use of Metadata's `alternates.canonical` field
// anywhere in this codebase (confirmed absent from every other route
// during the BLOG-1 design audit) -- deliberately scoped to this new
// surface only, never retrofitted onto unrelated existing routes in
// this same pass.
export function generateMetadata(): Metadata {
  const origin = resolveSiteOrigin();
  const title = "Blog";
  const description =
    "Këshilla, udhëzues dhe histori nga bota e vetëpublikimit shqip -- si të shkruash, botosh dhe promovosh librin tënd me Librum.";

  return {
    title,
    description,
    alternates: { canonical: `${origin}/blog` },
    openGraph: {
      title: `${title} — Librum`,
      description,
      url: `${origin}/blog`,
      type: "website",
    },
    twitter: {
      card: "summary",
    },
  };
}

type BlogLandingRow = BlogLandingCandidate;

function toCardPost(post: BlogLandingCandidate, coverUrl: string | null): BlogArticleCardPost {
  return {
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    category: post.category,
    coverUrl,
    published_at: post.published_at,
  };
}

export default async function BlogIndexPage() {
  const supabase = await createClient();

  // ONE bounded query serves the whole page -- featured, latest, and
  // every category section are all derived in memory from this same
  // list (see blog-landing-logic.ts's own header for the full
  // reasoning). Public/RLS-backed request-scoped client only -- never
  // the admin/service-role client; the "published only" filter below is
  // a query-shape convenience, not the actual security boundary (the
  // RLS policy itself is what makes a draft genuinely unreachable here,
  // even if this filter were ever accidentally removed).
  const { data } = await supabase
    .from("blog_posts")
    .select("id, slug, title, excerpt, category, cover_image_path, published_at, status, featured")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(BLOG_LANDING_CANDIDATE_LIMIT)
    .returns<BlogLandingRow[]>();

  const candidates = data ?? [];

  const featured = selectFeaturedPost(candidates);
  const latest = selectLatestPosts(candidates, featured?.id ?? null);
  const categorySections = BLOG_CATEGORIES.map((c) => ({
    category: c.value,
    posts: selectCategoryPosts(candidates, c.value),
  }));

  const empty = isBlogLandingEmpty({ featured, latest, categorySections });

  function coverUrlFor(path: string | null): string | null {
    return path ? supabase.storage.from("blog").getPublicUrl(path).data.publicUrl : null;
  }

  return (
    <main className="mx-auto w-full max-w-wide flex-1 px-4 py-12 sm:px-6">
      <div className="max-w-2xl">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">Blog</p>
        <h1 className="mt-1 font-serif text-3xl font-semibold text-foreground md:text-4xl">
          Blogu i Librum
        </h1>
        <p className="mt-3 text-muted">
          Këshilla, udhëzues dhe histori nga bota e vetëpublikimit shqip — si të shkruash, redaktosh,
          botosh dhe promovosh librin tënd.
        </p>
      </div>

      {empty ? (
        <EmptyState
          className="mt-10"
          title="Artikujt e parë po vijnë së shpejti."
          description="Ekipi ynë editorial po përgatit udhëzuesit e parë për autorët dhe lexuesit. Kthehu shpejt."
        />
      ) : (
        <div className="mt-10 flex flex-col gap-14">
          {featured && (
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
                Artikulli kryesor
              </h2>
              <div className="mt-4 max-w-2xl">
                <BlogArticleCard post={toCardPost(featured, coverUrlFor(featured.cover_image_path))} />
              </div>
            </section>
          )}

          {latest.length > 0 && (
            <section>
              <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Më të fundit</h2>
              <div className="mt-4 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
                {latest.map((post) => (
                  <BlogArticleCard key={post.id} post={toCardPost(post, coverUrlFor(post.cover_image_path))} />
                ))}
              </div>
            </section>
          )}

          {categorySections.map(
            (section) =>
              section.posts.length > 0 && (
                <section key={section.category}>
                  <div className="flex items-baseline justify-between">
                    <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
                      {BLOG_CATEGORY_LABELS_SQ[section.category]}
                    </h2>
                  </div>
                  <div className="mt-4 grid grid-cols-1 gap-8 sm:grid-cols-2 lg:grid-cols-3">
                    {section.posts.map((post) => (
                      <BlogArticleCard
                        key={post.id}
                        post={toCardPost(post, coverUrlFor(post.cover_image_path))}
                      />
                    ))}
                  </div>
                </section>
              ),
          )}
        </div>
      )}

      {!empty && (
        <div className="mt-14 border-t border-border pt-8 text-center">
          <p className="text-muted">Gati të botosh librin tënd?</p>
          <Link
            href="/signup?role=author"
            className="mt-3 inline-block rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
          >
            Boto librin tënd
          </Link>
        </div>
      )}
    </main>
  );
}
