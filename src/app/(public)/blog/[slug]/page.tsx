import Link from "next/link";
import { blogNowIso } from "@/lib/blog-schedule";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { resolveSiteOrigin } from "@/lib/site-url";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { calculateReadingTime } from "@/lib/blog-reading-time";
import { blogBylineName, blogJsonLdAuthor } from "@/lib/blog-byline";
import { blogCategoryHref, getBlogCategory } from "@/lib/blog-categories";
import { getBlogCategories } from "@/lib/blog-categories-server";
import { BLOG_RELATED_POSTS_LIMIT, selectRelatedPosts, type BlogLandingCandidate } from "@/lib/blog-landing-logic";
import { BlogMarkdown } from "@/components/blog-markdown";
import { BlogArticleCard, NgaLibrumTag, type BlogArticleCardPost } from "@/components/blog-article-card";
import { BlogCta } from "@/components/blog-category-nav";
import { ShareButtons } from "@/components/share-buttons";
import { BlogReactions } from "@/components/blog-reactions";
import {
  emptyBlogReactionCounts,
  groupBlogReactionCounts,
  isBlogReaction,
  type BlogReaction,
  type BlogReactionCountRow,
} from "@/lib/blog-reactions";
import { pageErrorMessage } from "@/lib/page-messages";

type PublicBlogPostDetail = {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  content_markdown: string;
  cover_image_path: string | null;
  category: string;
  is_editorial: boolean;
  author_name: string | null;
  seo_title: string | null;
  seo_description: string | null;
  published_at: string | null;
  updated_at: string;
};

// LIBRUM 2.0 BLOG-1D: mirrors Book Detail's own PERF-1 pattern exactly
// (src/app/(public)/libra/[id]/page.tsx's getBookForDetail) --
// generateMetadata() and the page component are separate invocations
// Next.js calls for the same request; cache() (React's per-request
// memoization, cleared once the request finishes, never a persistent/
// cross-request cache) makes both share the one fetch instead of paying
// for the row twice. Filters status='published' at the query level --
// a query-shape convenience, not the security boundary; the RLS policy
// itself is what makes a draft slug genuinely unreachable through the
// public request-scoped client this uses, even if this filter were
// ever accidentally dropped (see 047_blog_posts_rls.test.sql's own Part
// 1/4 for that proof at the DB layer). Public/RLS-backed client only --
// never the admin/service-role client.
const getPublishedBlogPostBySlug = cache(async (slug: string) => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("blog_posts")
    .select(
      "id, title, slug, excerpt, content_markdown, cover_image_path, category, is_editorial, author_name, seo_title, seo_description, published_at, updated_at",
    )
    .eq("slug", slug)
    .eq("status", "published")
    .lte("published_at", blogNowIso())
    .maybeSingle<PublicBlogPostDetail>();
  return data;
});

const METADATA_DESCRIPTION_MAX = 160;
function truncateForMetadata(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const post = await getPublishedBlogPostBySlug(slug);

  // A missing or draft slug never gets article-specific public metadata
  // -- <head> is readable by crawlers/link-preview bots regardless of
  // session, so it must never present a private draft's title/
  // description/cover as public marketing copy. Falling back to {}
  // lets the root layout's generic site metadata apply instead, exactly
  // matching Book Detail's own precedent.
  if (!post) return {};

  const title = post.seo_title ?? post.title;
  const description = post.seo_description ?? truncateForMetadata(post.excerpt, METADATA_DESCRIPTION_MAX);
  const origin = resolveSiteOrigin();
  const url = `${origin}/blog/${post.slug}`;

  const supabase = await createClient();
  const coverUrl = post.cover_image_path
    ? supabase.storage.from("blog").getPublicUrl(post.cover_image_path).data.publicUrl
    : null;

  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: {
      title,
      description,
      url,
      type: "article",
      ...(post.published_at ? { publishedTime: post.published_at } : {}),
      modifiedTime: post.updated_at,
      ...(coverUrl ? { images: [{ url: coverUrl }] } : {}),
    },
    twitter: {
      card: coverUrl ? "summary_large_image" : "summary",
    },
  };
}

// LIBRUM 2.0 BLOG-1D: Article JSON-LD, the one permitted use of a
// script tag on this page. Safe by construction: JSON.stringify()
// produces a JSON string (never HTML), and the one remaining risk --
// a literal `</script>` sequence inside a string VALUE prematurely
// closing this tag in the browser's HTML parser -- is closed by
// escaping every `<` to its unicode escape, the same established
// pattern used anywhere else untrusted-shaped text is serialized into
// a script tag. Every field here is either staff-authored plain text
// (title/excerpt/seo_*) already bounded by migration 047's own length
// CHECK constraints, or a controlled date/URL this function itself
// constructs -- never raw Markdown body content.
function ArticleJsonLd({ post, url, coverUrl }: { post: PublicBlogPostDetail; url: string; coverUrl: string | null }) {
  const jsonLdAuthor = blogJsonLdAuthor(post);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.seo_title ?? post.title,
    description: post.seo_description ?? post.excerpt,
    datePublished: post.published_at ?? post.updated_at,
    dateModified: post.updated_at,
    // au3 (Renato 2026-11-22): a typed "Written by" name is the author;
    // with none, Editorial names "Librum Editorial" (audit F3) and every
    // other post "Librum" (au2 reversed 2026-11-23).
    author: jsonLdAuthor,
    publisher: { "@type": "Organization", name: "Librum" },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    ...(coverUrl ? { image: [coverUrl] } : {}),
  };

  const safeJson = JSON.stringify(jsonLd).replace(/</g, "\\u003c");

  return (
    <script
      type="application/ld+json"
      // Structured data only, never HTML -- see this component's own header comment for the escaping rationale.
      dangerouslySetInnerHTML={{ __html: safeJson }}
    />
  );
}

export default async function BlogArticlePage({
  params,
  searchParams = Promise.resolve({}),
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ error?: string }>;
}) {
  const { slug } = await params;
  const { error: rawError } = await searchParams;
  const post = await getPublishedBlogPostBySlug(slug);

  if (!post) {
    notFound();
  }

  const supabase = await createClient();
  const coverUrl = post.cover_image_path
    ? supabase.storage.from("blog").getPublicUrl(post.cover_image_path).data.publicUrl
    : null;

  // Related reading: its own small, separately-bounded query (max 3
  // rows) -- not derivable from the single detail row above, but still
  // explicit columns only, never content_markdown, and never re-fetches
  // the current article's own body a second time.
  const { data: relatedCandidatesData } = await supabase
    .from("blog_posts")
    .select("id, slug, title, excerpt, category, is_editorial, cover_image_path, published_at, status, featured")
    .eq("status", "published")
    .lte("published_at", blogNowIso())
    .eq("category", post.category)
    .neq("id", post.id)
    .order("published_at", { ascending: false })
    .limit(BLOG_RELATED_POSTS_LIMIT)
    .returns<BlogLandingCandidate[]>();

  const related = selectRelatedPosts(relatedCandidatesData ?? [], post.category, post.id);

  // BR1 (2026-11-23): totals come from a function that returns numbers
  // only, never who reacted; the reader's own picks are their own rows.
  const [{ data: reactionRows, error: reactionCountsError }, { data: authData }] = await Promise.all([
    supabase.rpc("blog_post_reaction_counts", { p_post_ids: [post.id] }),
    supabase.auth.getUser(),
  ]);
  // Audit L2: a failed read shows the buttons without numbers; the log
  // line (no user data) is what the release error read catches.
  if (reactionCountsError) console.error("blog article: reaction counts read failed", { code: reactionCountsError.code });
  const reactionCounts = groupBlogReactionCounts(reactionRows as BlogReactionCountRow[] | null).get(post.id) ?? emptyBlogReactionCounts();
  const reader = authData.user;
  const myReactions = new Set<BlogReaction>();
  if (reader) {
    const { data: mine, error: mineError } = await supabase
      .from("blog_post_reactions")
      .select("reaction")
      .eq("post_id", post.id)
      .eq("user_id", reader.id)
      .returns<{ reaction: string }[]>();
    if (mineError) console.error("blog article: own reactions read failed", { code: mineError.code });
    for (const row of mine ?? []) if (isBlogReaction(row.reaction)) myReactions.add(row.reaction);
  }
  const reactionError = pageErrorMessage(rawError);

  const readingMinutes = calculateReadingTime(post.content_markdown);
  // Blog categories (2026-11-17): Editorial posts carry the yellow
  // "Editorial" tag and a thin gold line (blog1/blog3); every other
  // post links its category name to the category page. The bottom
  // button follows the category (blog6). bs1: an Editorial post is the tick on top of a
  // real category, so it shows the tag AND its category link.
  const categories = await getBlogCategories();
  const categoryInfo = getBlogCategory(categories, post.category);
  const isEditorial = post.is_editorial === true;
  // A typed name on any article, else "Librum" on every article (au2
  // reversed 2026-11-23).
  const bylineName = blogBylineName(post);
  const origin = resolveSiteOrigin();
  const url = `${origin}/blog/${post.slug}`;

  function relatedCardPost(candidate: BlogLandingCandidate): BlogArticleCardPost {
    return {
      slug: candidate.slug,
      title: candidate.title,
      excerpt: candidate.excerpt,
      category: candidate.category,
      is_editorial: candidate.is_editorial,
      coverUrl: candidate.cover_image_path
        ? supabase.storage.from("blog").getPublicUrl(candidate.cover_image_path).data.publicUrl
        : null,
      published_at: candidate.published_at,
    };
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 pt-5 pb-12 sm:px-6 sm:pt-10">
      <ArticleJsonLd post={post} url={url} coverUrl={coverUrl} />

      <Link href="/blog" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
        &larr; Blog
      </Link>

      <article className={isEditorial ? "mt-4 border-t-[3px] border-accent pt-5" : "mt-4"}>
        {isEditorial || categoryInfo ? (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-medium uppercase tracking-wide">
            {isEditorial && <NgaLibrumTag />}
            {categoryInfo && (
            <Link
              href={blogCategoryHref(categoryInfo)}
              className="underline underline-offset-[3px] hover:decoration-2"
              style={{ color: categoryInfo.ink }}
            >
              {categoryInfo.label}
            </Link>
            )}
          </p>
        ) : null}
        <h1 className="mt-1 font-serif text-3xl font-normal text-foreground md:text-4xl">
          {post.title}
        </h1>
        <p className="mt-3 text-lg text-muted">{post.excerpt}</p>

        <p className="mt-4 text-sm text-muted">
          {`Nga ${bylineName} · `}
          {post.published_at && `${formatTimestampAsDate(post.published_at)} · `}
          {readingMinutes} min lexim
        </p>

        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coverUrl} alt="" className="mt-6 aspect-[3/2] w-full rounded-card object-cover" />
        ) : null}

        <div className="mt-8">
          <BlogMarkdown markdown={post.content_markdown} />
        </div>
      </article>

      {/* BR1 (Renato, 2026-11-23): reactions at the end of the article,
          above the share row (br1 q5). */}
      <section id="reagime" aria-label="Reagime" className="mt-10 scroll-mt-24 text-sm">
        {reactionError && (
          <p role="alert" className="mb-3 rounded-card bg-red-50 px-3 py-2 text-red-700">
            {reactionError}
          </p>
        )}
        <BlogReactions
          postId={post.id}
          slug={post.slug}
          counts={reactionCounts}
          mine={myReactions}
          signedIn={reader !== null}
        />
      </section>

      {/* SOCIAL (Renato soc2, 2026-11-18): the same share row as the book
          page, at the end of the article. */}
      <ShareButtons url={url} text={`${post.title} në Librum`} className="mt-8 text-sm" />

      {related.length > 0 && (
        <section className="mt-14 border-t border-border pt-8">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Lexime të ngjashme</h2>
          <div className="mt-4 grid grid-cols-1 gap-8 sm:grid-cols-3">
            {related.map((candidate) => (
              <BlogArticleCard key={candidate.id} post={relatedCardPost(candidate)} categories={categories} />
            ))}
          </div>
        </section>
      )}

      <BlogCta kind={categoryInfo?.cta ?? "publish"} />
    </main>
  );
}
