import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { resolveSiteOrigin } from "@/lib/site-url";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";
import { calculateReadingTime } from "@/lib/blog-reading-time";
import { BLOG_CATEGORY_LABELS_SQ } from "@/lib/blog-categories";
import { BLOG_RELATED_POSTS_LIMIT, selectRelatedPosts, type BlogLandingCandidate } from "@/lib/blog-landing-logic";
import { BlogMarkdown } from "@/components/blog-markdown";
import { BlogArticleCard, type BlogArticleCardPost } from "@/components/blog-article-card";
import type { BlogCategory } from "@/lib/types";

type PublicBlogPostDetail = {
  id: string;
  title: string;
  slug: string;
  excerpt: string;
  content_markdown: string;
  cover_image_path: string | null;
  category: BlogCategory;
  seo_title: string | null;
  seo_description: string | null;
  published_at: string | null;
  updated_at: string;
};

// LIBRUM 2.0 BLOG-1D: mirrors Book Detail's own PERF-1 pattern exactly
// (src/app/(public)/books/[id]/page.tsx's getBookForDetail) --
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
      "id, title, slug, excerpt, content_markdown, cover_image_path, category, seo_title, seo_description, published_at, updated_at",
    )
    .eq("slug", slug)
    .eq("status", "published")
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
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.seo_title ?? post.title,
    description: post.seo_description ?? post.excerpt,
    datePublished: post.published_at ?? post.updated_at,
    dateModified: post.updated_at,
    author: { "@type": "Organization", name: "Librum Editorial" },
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

export default async function BlogArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
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
    .select("id, slug, title, excerpt, category, cover_image_path, published_at, status, featured")
    .eq("status", "published")
    .eq("category", post.category)
    .neq("id", post.id)
    .order("published_at", { ascending: false })
    .limit(BLOG_RELATED_POSTS_LIMIT)
    .returns<BlogLandingCandidate[]>();

  const related = selectRelatedPosts(relatedCandidatesData ?? [], post.category, post.id);

  const readingMinutes = calculateReadingTime(post.content_markdown);
  const origin = resolveSiteOrigin();
  const url = `${origin}/blog/${post.slug}`;

  function relatedCardPost(candidate: BlogLandingCandidate): BlogArticleCardPost {
    return {
      slug: candidate.slug,
      title: candidate.title,
      excerpt: candidate.excerpt,
      category: candidate.category,
      coverUrl: candidate.cover_image_path
        ? supabase.storage.from("blog").getPublicUrl(candidate.cover_image_path).data.publicUrl
        : null,
      published_at: candidate.published_at,
    };
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-6">
      <ArticleJsonLd post={post} url={url} coverUrl={coverUrl} />

      <Link href="/blog" className="text-sm text-muted hover:underline">
        &larr; Blog
      </Link>

      <article className="mt-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">
          {BLOG_CATEGORY_LABELS_SQ[post.category]}
        </p>
        <h1 className="mt-1 font-serif text-3xl font-semibold text-foreground md:text-4xl">
          {post.title}
        </h1>
        <p className="mt-3 text-lg text-muted">{post.excerpt}</p>

        <p className="mt-4 text-sm text-muted">
          Nga Librum Editorial
          {post.published_at && (
            <>
              {" · "}
              {formatTimestampAsDate(post.published_at)}
            </>
          )}
          {" · "}
          {readingMinutes} min lexim
        </p>

        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coverUrl} alt="" className="mt-6 aspect-[3/2] w-full rounded-lg object-cover" />
        ) : null}

        <div className="mt-8">
          <BlogMarkdown markdown={post.content_markdown} />
        </div>
      </article>

      {related.length > 0 && (
        <section className="mt-14 border-t border-border pt-8">
          <h2 className="text-xs font-medium uppercase tracking-wide text-muted">Lexime të ngjashme</h2>
          <div className="mt-4 grid grid-cols-1 gap-8 sm:grid-cols-3">
            {related.map((candidate) => (
              <BlogArticleCard key={candidate.id} post={relatedCardPost(candidate)} />
            ))}
          </div>
        </section>
      )}

      <div className="mt-14 border-t border-border pt-8 text-center">
        <p className="text-muted">Gati të botosh librin tënd?</p>
        <Link
          href="/signup?role=author"
          className="mt-3 inline-block rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary-hover"
        >
          Boto librin tënd
        </Link>
      </div>
    </main>
  );
}
