import Link from "next/link";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { resolveSiteOrigin } from "@/lib/site-url";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import {
  BLOG_CATEGORIES,
  BLOG_CATEGORY_EMPTY_LINE,
  blogCategoryHref,
  getBlogCategory,
} from "@/lib/blog-categories";
import {
  BLOG_CATEGORY_SECTION_LIMIT,
  BLOG_LANDING_CANDIDATE_LIMIT,
  isBlogLandingEmpty,
  selectCategoryPosts,
  selectFeaturedPost,
  selectLatestPosts,
  type BlogLandingCandidate,
} from "@/lib/blog-landing-logic";
import {
  BlogArticleCard,
  BlogCategoryLabel,
  type BlogArticleCardPost,
} from "@/components/blog-article-card";
import { BlogCategoryButtons, BlogCta } from "@/components/blog-category-nav";
import { BlogSearchBox } from "@/components/blog-search-box";
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
    "Shkrim, botim, kulturë dhe lexim: këshilla, ese dhe rekomandime për këdo që e do librin shqip.";

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
    is_editorial: post.is_editorial,
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
    .select("id, slug, title, excerpt, category, is_editorial, cover_image_path, published_at, status, featured")
    .eq("status", "published")
    .order("published_at", { ascending: false })
    .limit(BLOG_LANDING_CANDIDATE_LIMIT)
    .returns<BlogLandingRow[]>();

  const candidates = data ?? [];

  const featured = selectFeaturedPost(candidates);
  const latest = selectLatestPosts(candidates, featured?.id ?? null);
  // Blog categories (2026-11-17, blog8): all six bands always show,
  // Editorial first; an empty one keeps its band with one line. Each
  // band has its own small query (audit r1 F1): filled from the 50
  // newest posts above, a quiet category with only older posts would
  // wrongly say "coming soon". Six bounded queries (3 rows each,
  // summary columns only) run in parallel; selectCategoryPosts()
  // re-checks status and category on whatever comes back.
  // bs1 a: the Editorial band reads the is_editorial tick; every
  // other band reads category, so an Editorial post shows in both.
  const bandResults = await Promise.all(
    BLOG_CATEGORIES.map((c) => {
      const q = supabase
        .from("blog_posts")
        .select("id, slug, title, excerpt, category, is_editorial, cover_image_path, published_at, status, featured")
        .eq("status", "published");
      return (c.value === "editorial" ? q.eq("is_editorial", true) : q.eq("category", c.value))
        .order("published_at", { ascending: false })
        .limit(BLOG_CATEGORY_SECTION_LIMIT)
        .returns<BlogLandingRow[]>();
    }),
  );
  const categorySections = BLOG_CATEGORIES.map((c, i) => ({
    category: c,
    posts: selectCategoryPosts(bandResults[i].data ?? [], c.value),
  }));

  const empty = isBlogLandingEmpty({ featured, latest, categorySections });

  function coverUrlFor(path: string | null): string | null {
    return path ? supabase.storage.from("blog").getPublicUrl(path).data.publicUrl : null;
  }

  // An Editorial lead keeps the Editorial colour line it had before bs1.
  const featuredInfo = featured
    ? getBlogCategory(featured.is_editorial ? "editorial" : featured.category)
    : undefined;
  const featuredCover = featured ? coverUrlFor(featured.cover_image_path) : null;

  return (
    <main className="flex-1 pt-5 sm:pt-10">
      <div className="page-container">
        <div className="max-w-2xl">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Blog</p>
          <h1 className="mt-1 font-serif text-3xl font-normal text-foreground md:text-4xl">
            Blogu i Librum
          </h1>
          <p className="mt-3 text-muted">
            Shkrim, botim, kulturë dhe lexim: këshilla, ese dhe rekomandime për këdo që e do librin
            shqip.
          </p>
        </div>

        <div className="mt-7">
          <BlogSearchBox />
        </div>

        <div className="mt-5">
          <BlogCategoryButtons active={null} />
        </div>
      </div>

      {empty ? (
        <div className="page-container pb-12">
          <EmptyState
            className="mt-10"
            title="Artikujt e parë po vijnë së shpejti."
            description="Ekipi ynë editorial po përgatit udhëzuesit e parë për autorët dhe lexuesit. Kthehuni së shpejti."
          />
        </div>
      ) : (
        <>
          <div className="page-container mt-9 flex flex-col gap-14 pb-14">
            {featured && (
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted">
                  Artikulli kryesor
                </h2>
                <Link
                  href={`/blog/${featured.slug}`}
                  className="focus-ring group mt-4 grid grid-cols-1 items-center gap-4 rounded-card border-t-[3px] bg-violet-tint p-4 md:grid-cols-[7fr_5fr] md:gap-10 md:p-6"
                  style={{ borderTopColor: featuredInfo?.ink ?? "var(--color-accent)" }}
                >
                  {featuredCover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={featuredCover}
                      alt=""
                      decoding="async"
                      className="aspect-[3/2] w-full rounded-card object-cover"
                    />
                  ) : (
                    <div className="aspect-[3/2] w-full rounded-card bg-border" />
                  )}
                  <div>
                    <BlogCategoryLabel category={featured.category} isEditorial={featured.is_editorial} />
                    <p className="mt-3 font-serif text-2xl leading-tight text-foreground group-hover:underline md:text-3xl">
                      {featured.title}
                    </p>
                    <p className="mt-3 text-muted">{featured.excerpt}</p>
                    {featured.published_at && (
                      <p className="mt-2 text-xs text-muted">
                        {formatTimestampAsDate(featured.published_at)}
                      </p>
                    )}
                  </div>
                </Link>
              </section>
            )}

            {latest.length > 0 && (
              <section>
                <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Më të fundit</h2>
                <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-8 lg:grid-cols-3">
                  {latest.map((post) => (
                    <BlogArticleCard
                      key={post.id}
                      compactOnMobile
                      post={toCardPost(post, coverUrlFor(post.cover_image_path))}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>

          {categorySections.map(({ category, posts }) => (
            <section
              key={category.value}
              aria-labelledby={`blog-band-${category.value}`}
              className="py-7 sm:pt-10 sm:pb-12"
              style={{ backgroundColor: category.tint }}
            >
              <div className="page-container">
                <div
                  className="flex items-baseline justify-between gap-4 border-b pb-2.5"
                  style={{ borderColor: `${category.ink}33` }}
                >
                  <div>
                    <h2
                      id={`blog-band-${category.value}`}
                      className="font-serif text-2xl font-normal"
                      style={{ color: category.ink }}
                    >
                      {category.label}
                    </h2>
                    <p className="mt-0.5 text-sm text-muted">{category.description}</p>
                  </div>
                  <Link
                    href={blogCategoryHref(category)}
                    className="focus-ring shrink-0 whitespace-nowrap rounded-sm text-sm underline underline-offset-[3px]"
                    style={{ color: category.ink }}
                  >
                    Të gjitha <span aria-hidden="true">&rarr;</span>
                    <span className="sr-only"> në {category.label}</span>
                  </Link>
                </div>
                {posts.length > 0 ? (
                  <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-8 lg:grid-cols-3">
                    {posts.map((post) => (
                      <BlogArticleCard
                        key={post.id}
                        compactOnMobile
                        post={toCardPost(post, coverUrlFor(post.cover_image_path))}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="mt-4 text-muted">{BLOG_CATEGORY_EMPTY_LINE}</p>
                )}
              </div>
            </section>
          ))}

          <div className="page-container pb-12">
            <BlogCta kind="publish" />
          </div>
        </>
      )}
    </main>
  );
}
