import type { MetadataRoute } from "next";
import { blogNowIso } from "@/lib/blog-schedule";
import { resolveSiteOrigin } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";
import { authorPagePath } from "@/lib/pen-names";
import { bookPagePath, bundlePagePath, seriesPagePath } from "@/lib/seo";
import { LISTED_BOOK_STATUSES } from "@/lib/preorder-reader";
import { classicAuthorPath } from "@/lib/classic-authors";
import { BLOG_CATEGORY_COLUMNS, blogCategoryHref, toBlogCategories, type BlogCategoryRow } from "@/lib/blog-categories";

// LIBRUM 2.0 LAUNCH-FIX-1A SEO-2: static public/marketing routes. The
// per-entity pages (books/authors/series/bundles) were left for a later
// pass; P2 adds them below (catalogSitemapEntries).
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
  "/rreth-nesh",
  "/si-funksionon",
  "/fitimet",
  "/librari",
  // M1 (Renato 11-27, fx5 a).
  "/librari/cfare-po-lexojme",
  "/ndihme",
  "/ndihme/leximi",
  "/ndihme/word",
  "/kontakt",
  "/kushtet",
  "/privatesia",
  "/rimbursimet",
  "/aksesueshmeria",
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
    .lte("published_at", blogNowIso())
    .returns<{ slug: string; updated_at: string }[]>();

  return (data ?? []).map((post) => ({
    url: `${origin}/blog/${post.slug}`,
    lastModified: new Date(post.updated_at),
  }));
}

// P2 (Renato 10-29): books, authors, series and bundles. Each list
// matches what the public pages themselves show (3a): a published book
// with an authored price (Librari's rule, 2a), the pen names and series
// of those books (an author or series page lists exactly those), and a
// published, priced bundle. `.eq("status", "published")` is explicit
// even though anon RLS already implies it: public_books/public_bundles
// also return an author's own drafts to that author, and this sitemap
// must read the same for a signed-in author as for a crawler. Authors
// are /autore/<pen name id> -- never an account id.
//
// Supabase returns at most 1000 rows per request, so both lists are read
// in id-ordered pages, up to SITEMAP_MAX_PAGES pages each (far beyond
// today's catalog; a sitemap file holds 50,000 addresses at most).
const SITEMAP_PAGE_SIZE = 1000;
const SITEMAP_MAX_PAGES = 20;

type SitemapBookRow = {
  id: string;
  pen_name_id: string | null;
  series_id: string | null;
  pd_work_id: string | null;
  status: string;
  updated_at: string;
};
type SitemapBundleRow = { id: string; updated_at: string };

async function readAllPages<T>(
  readPage: (from: number, to: number) => PromiseLike<{ data: T[] | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 0; page < SITEMAP_MAX_PAGES; page++) {
    const from = page * SITEMAP_PAGE_SIZE;
    const { data } = await readPage(from, from + SITEMAP_PAGE_SIZE - 1);
    const pageRows = data ?? [];
    rows.push(...pageRows);
    if (pageRows.length < SITEMAP_PAGE_SIZE) break;
  }
  return rows;
}

function latest(map: Map<string, Date>, key: string, date: Date) {
  const current = map.get(key);
  if (!current || date > current) map.set(key, date);
}

async function catalogSitemapEntries(origin: string): Promise<MetadataRoute.Sitemap> {
  const supabase = await createClient();
  const [books, bundles] = await Promise.all([
    readAllPages<SitemapBookRow>((from, to) =>
      supabase
        .from("public_books")
        .select("id, pen_name_id, series_id, pd_work_id, status, updated_at")
        // BD16 P4 (D1): a pre-order's page is public, so it is listed.
        .in("status", LISTED_BOOK_STATUSES)
        .not("price_all", "is", null)
        .order("id")
        .range(from, to)
        .returns<SitemapBookRow[]>(),
    ),
    readAllPages<SitemapBundleRow>((from, to) =>
      supabase
        .from("public_bundles")
        .select("id, updated_at")
        .eq("status", "published")
        .not("price_all", "is", null)
        .order("id")
        .range(from, to)
        .returns<SitemapBundleRow[]>(),
    ),
  ]);

  const authors = new Map<string, Date>();
  const series = new Map<string, Date>();
  for (const book of books) {
    const updated = new Date(book.updated_at);
    if (book.pen_name_id) latest(authors, book.pen_name_id, updated);
    if (book.series_id) latest(series, book.series_id, updated);
  }

  // M1 (Renato 11-27, fx5 a): classic author pages, by the page's own
  // rule -- a published, priced edition of one of their works (a
  // pre-order alone doesn't open the page).
  const classicWorks = new Map<string, Date>();
  for (const book of books) {
    if (book.pd_work_id && book.status === "published") latest(classicWorks, book.pd_work_id, new Date(book.updated_at));
  }
  const classics = new Map<string, Date>();
  if (classicWorks.size > 0) {
    const { data: classicAuthors } = await supabase
      .from("public_classic_authors")
      .select("slug, pd_work_ids")
      .overlaps("pd_work_ids", [...classicWorks.keys()])
      .returns<{ slug: string; pd_work_ids: string[] | null }[]>();
    for (const author of classicAuthors ?? []) {
      for (const workId of author.pd_work_ids ?? []) {
        const updated = classicWorks.get(workId);
        if (updated) latest(classics, author.slug, updated);
      }
    }
  }

  return [
    ...books.map((book) => ({
      url: `${origin}${bookPagePath(book.id)}`,
      lastModified: new Date(book.updated_at),
    })),
    ...[...authors].map(([id, lastModified]) => ({ url: `${origin}${authorPagePath(id)}`, lastModified })),
    ...[...series].map(([id, lastModified]) => ({ url: `${origin}${seriesPagePath(id)}`, lastModified })),
    ...[...classics].map(([slug, lastModified]) => ({ url: `${origin}${classicAuthorPath(slug)}`, lastModified })),
    ...bundles.map((bundle) => ({
      url: `${origin}${bundlePagePath(bundle.id)}`,
      lastModified: new Date(bundle.updated_at),
    })),
  ];
}

// M1 (Renato 11-27, fx5 a): every blog category page (an empty
// category keeps its page too, blog8). A failed read leaves them out
// instead of failing the whole sitemap.
async function blogCategorySitemapEntries(origin: string): Promise<MetadataRoute.Sitemap> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("blog_categories")
    .select(BLOG_CATEGORY_COLUMNS)
    .order("sort_order", { ascending: true })
    .returns<BlogCategoryRow[]>();
  return toBlogCategories(data ?? []).map((category) => ({
    url: `${origin}${blogCategoryHref(category)}`,
    lastModified: new Date(),
  }));
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = resolveSiteOrigin();

  const staticEntries: MetadataRoute.Sitemap = STATIC_PUBLIC_ROUTES.map((path) => ({
    url: `${origin}${path}`,
    lastModified: new Date(),
  }));
  const blogIndexEntry: MetadataRoute.Sitemap = [{ url: `${origin}/blog`, lastModified: new Date() }];

  const [blogEntries, blogCategoryEntries, catalogEntries] = await Promise.all([
    blogSitemapEntries(origin),
    blogCategorySitemapEntries(origin),
    catalogSitemapEntries(origin),
  ]);

  return [...staticEntries, ...blogIndexEntry, ...blogCategoryEntries, ...blogEntries, ...catalogEntries];
}
