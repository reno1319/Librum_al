import type { MetadataRoute } from "next";
import { resolveSiteOrigin } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";

// LIBRUM 2.0 LAUNCH-FIX-1A SEO-2: static public/marketing routes only
// for this pass -- per-entity pages (books/authors/series/bundles) are
// dynamic, and a correct dynamic sitemap needs its own bounded,
// published-only query design (pagination, per-table "is this actually
// public" filtering matching each page's own RLS-backed query) that
// this small reliability pass deliberately doesn't take on. See this
// pass's own report for the explicit follow-up recommendation -- this
// is a conscious scope decision, not an oversight.
//
// /products and /program are intentionally absent: IA-1A (this same
// pass) retired both routes as orphaned, unlinked placeholders. Auth
// pages (/login, /signup, /forgot-password, /reset-password) and every
// private, login-gated route are intentionally absent too -- a sitemap
// is "please index this," not merely "this isn't blocked"; robots.ts
// (also this pass) is what governs crawl access to those.
//
// force-dynamic for the same reason as robots.ts -- resolveSiteOrigin()
// must not run at build time in an environment where
// NEXT_PUBLIC_SITE_URL isn't set (it deliberately throws rather than
// emit a broken URL; see that file's own comment).
export const dynamic = "force-dynamic";

const STATIC_PUBLIC_ROUTES = [
  "",
  "/about",
  "/how-it-works",
  "/pricing",
  "/bookstore",
  "/help",
  "/contact",
  "/terms",
  "/privacy",
];

// LIBRUM 2.0 BLOG-1D: the first dynamic, DB-backed entries this sitemap
// has ever had -- everything above this point is still the static list
// SEO-2 originally shipped, untouched. `/blog` itself is appended
// statically alongside the other marketing routes; every published
// `/blog/[slug]` is appended below via one bounded, explicit-column
// query through the public/RLS-backed request-scoped client (never the
// admin/service-role client) -- the same `status = 'published'` filter
// every other public Blog query in this codebase uses, so a draft can
// never appear here even before RLS's own backstop is considered.
// lastModified uses each post's real updated_at, never a synthetic
// "now" -- consistent with how a per-entity dynamic sitemap should
// reflect actual content freshness, not deployment time.
async function blogSitemapEntries(origin: string): Promise<MetadataRoute.Sitemap> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("blog_posts")
    .select("slug, updated_at")
    .eq("status", "published")
    .returns<{ slug: string; updated_at: string }[]>();

  return (data ?? []).map((post) => ({
    url: `${origin}/blog/${post.slug}`,
    lastModified: new Date(post.updated_at),
  }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = resolveSiteOrigin();

  const staticEntries: MetadataRoute.Sitemap = STATIC_PUBLIC_ROUTES.map((path) => ({
    url: `${origin}${path}`,
    lastModified: new Date(),
  }));
  const blogIndexEntry: MetadataRoute.Sitemap = [{ url: `${origin}/blog`, lastModified: new Date() }];

  return [...staticEntries, ...blogIndexEntry, ...(await blogSitemapEntries(origin))];
}
