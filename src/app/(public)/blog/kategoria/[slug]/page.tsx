import Link from "next/link";
import { blogNowIso } from "@/lib/blog-schedule";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { canonicalMetadata, NOT_FOUND_METADATA, shareCardImages } from "@/lib/seo";
import {
  BLOG_CATEGORY_EMPTY_LINE,
  blogCategoryHref,
  getBlogCategoryByUrlSlug,
  isPostInSection,
  type BlogCategoryInfo,
} from "@/lib/blog-categories";
import { getBlogCategories } from "@/lib/blog-categories-server";
import {
  blogCategoryPageCount,
  blogCategoryPageRange,
  parseBlogPageParam,
  type BlogLandingCandidate,
} from "@/lib/blog-landing-logic";
import { BlogArticleCard } from "@/components/blog-article-card";
import { BlogCategoryButtons, BlogCta } from "@/components/blog-category-nav";
import { BlogSearchBox } from "@/components/blog-search-box";

// Blog categories (Renato 2026-11-17, approved pictures): one page per
// category at /blog/kategoria/<urlSlug>. A header band in the
// category's colour, the category buttons with this one filled, 12
// posts per page with page numbers (?faqe=N), and the bottom button the
// category calls for (blog6). An empty category keeps its page with
// one line (blog8). Unknown category or out-of-range page: 404.
//
// Public/RLS-backed request-scoped client only -- never the
// admin/service-role client; RLS is what keeps drafts unreachable, the
// status filter is a query-shape convenience on top.

function pageHref(category: BlogCategoryInfo, page: number): string {
  return page === 1 ? blogCategoryHref(category) : `${blogCategoryHref(category)}?faqe=${page}`;
}

export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ faqe?: string | string[] }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const category = getBlogCategoryByUrlSlug(await getBlogCategories(), slug);
  const page = parseBlogPageParam((await searchParams).faqe);
  // S2 (pb1 a): the page answers notFound(); keep its tab title.
  if (!category || page === null) return NOT_FOUND_METADATA;

  const title = page === 1 ? `${category.label} · Blog` : `${category.label} · Blog · Faqja ${page}`;
  return {
    title,
    description: category.description,
    ...canonicalMetadata(pageHref(category, page)),
    // S1 (pb2 a): the site-wide share card.
    openGraph: { title: `${title} — Librum`, description: category.description, type: "website", ...shareCardImages() },
    twitter: { card: "summary_large_image" },
  };
}

export default async function BlogCategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ faqe?: string | string[] }>;
}) {
  const { slug } = await params;
  const categories = await getBlogCategories();
  const category = getBlogCategoryByUrlSlug(categories, slug);
  const page = parseBlogPageParam((await searchParams).faqe);
  if (!category || page === null) notFound();

  const supabase = await createClient();
  const { from, to } = blogCategoryPageRange(page);
  const base = supabase
    .from("blog_posts")
    .select("id, slug, title, excerpt, category, is_editorial, cover_image_path, published_at, status, featured", {
      count: "exact",
    })
    .eq("status", "published")
    .lte("published_at", blogNowIso());
  // bs1 a: /blog/kategoria/editorial lists the ticked posts; every other
  // page lists its category, Editorial posts included.
  const { data, count } = await (category.value === "editorial"
    ? base.eq("is_editorial", true)
    : base.eq("category", category.value))
    .order("published_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to)
    .returns<BlogLandingCandidate[]>();

  const posts = (data ?? []).filter((p) => p.status === "published" && isPostInSection(p, category.value));
  const pageCount = blogCategoryPageCount(count ?? 0);
  if (page > pageCount) notFound();

  function coverUrlFor(path: string | null): string | null {
    return path ? supabase.storage.from("blog").getPublicUrl(path).data.publicUrl : null;
  }

  const pages = Array.from({ length: pageCount }, (_, i) => i + 1);

  return (
    <main className="flex-1">
      <div style={{ backgroundColor: category.tint }}>
        <div className="page-container pt-6 pb-7">
          <Link href="/blog" className="text-sm text-muted underline underline-offset-2 hover:decoration-2">
            &larr; Blog
          </Link>
          <p
            className="mt-4 text-xs font-medium uppercase tracking-wide"
            style={{ color: category.ink }}
          >
            Kategori
          </p>
          <h1 className="mt-1 font-serif text-3xl font-normal md:text-4xl" style={{ color: category.ink }}>
            {category.label}
          </h1>
          <p className="mt-3 max-w-2xl text-muted">{category.description}</p>
        </div>
      </div>

      <div className="page-container pt-7 pb-12">
        <BlogSearchBox />

        <div className="mt-5">
          <BlogCategoryButtons active={category.value} categories={categories} />
        </div>

        {posts.length > 0 ? (
          <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 sm:gap-8 lg:grid-cols-3">
            {posts.map((post) => (
              <BlogArticleCard
                key={post.id}
                categories={categories}
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
        ) : (
          <p className="mt-8 text-muted">{BLOG_CATEGORY_EMPTY_LINE}</p>
        )}

        {pageCount > 1 && (
          <nav aria-label="Faqet" className="mt-10">
            <ul className="flex flex-wrap justify-center gap-2 text-sm">
              {page > 1 && (
                <li>
                  <Link
                    href={pageHref(category, page - 1)}
                    className="focus-ring inline-block rounded-[3px] border border-border bg-surface px-3 py-1.5"
                  >
                    <span aria-hidden="true">&larr;</span> Më parë
                  </Link>
                </li>
              )}
              {pages.map((n) => (
                <li key={n}>
                  <Link
                    href={pageHref(category, n)}
                    aria-current={n === page ? "page" : undefined}
                    className={
                      n === page
                        ? "focus-ring inline-block rounded-[3px] border px-3 py-1.5 text-white"
                        : "focus-ring inline-block rounded-[3px] border border-border bg-surface px-3 py-1.5"
                    }
                    style={n === page ? { backgroundColor: category.ink, borderColor: category.ink } : undefined}
                  >
                    {n}
                  </Link>
                </li>
              ))}
              {page < pageCount && (
                <li>
                  <Link
                    href={pageHref(category, page + 1)}
                    className="focus-ring inline-block rounded-[3px] border border-border bg-surface px-3 py-1.5"
                  >
                    Më pas <span aria-hidden="true">&rarr;</span>
                  </Link>
                </li>
              )}
            </ul>
          </nav>
        )}

        <BlogCta kind={category.cta} />
      </div>
    </main>
  );
}
