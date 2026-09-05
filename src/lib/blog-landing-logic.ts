import type { BlogCategory } from "./types";

// LIBRUM 2.0 BLOG-1D: the featured/latest/category SELECTION rules,
// extracted as pure functions so they're directly unit-testable
// without a real database (this repo's vitest config only runs
// `.test.ts`, environment "node") -- same extraction technique as
// resolveAdminLandingVisibility()/decideStaffAccess()/buildSiteHeaderNav().
//
// The public /blog page runs exactly ONE bounded DB query (the most
// recently published posts, up to BLOG_LANDING_CANDIDATE_LIMIT) and
// derives featured/latest/every category section from that single
// in-memory list via the functions below, rather than six separate
// round trips -- both a real perf win (one query instead of six) and
// what makes every selection RULE (not just "does the page render")
// independently testable: the DB's own status='published' filter and
// ORDER BY/LIMIT are a performance bound only, never the sole place
// "unpublished ignored" or "latest wins" is enforced -- these functions
// re-derive that themselves from a raw candidate list that may still
// contain drafts/non-featured/wrong-category rows.
//
// V1 bound, stated explicitly: as long as the whole published catalog
// stays under this limit (BLOG-1's own launch slate is ~10-12
// articles), every section always sees its true most-recent posts. If
// the catalog ever grows past this, a category with unusually sparse
// posting could theoretically have older posts outside the fetched
// window excluded from its own section -- an acceptable, documented V1
// trade-off per the brief's own "keep result sets bounded... do not
// build a complex recommendation engine" instruction, revisit only if
// real published volume ever approaches it.
export const BLOG_LANDING_CANDIDATE_LIMIT = 50;
export const BLOG_LATEST_SECTION_LIMIT = 6;
export const BLOG_CATEGORY_SECTION_LIMIT = 3;
export const BLOG_RELATED_POSTS_LIMIT = 3;

export type BlogLandingCandidate = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  category: BlogCategory;
  cover_image_path: string | null;
  published_at: string | null;
  status: "draft" | "published";
  featured: boolean;
};

function byLatestPublishedFirst(a: BlogLandingCandidate, b: BlogLandingCandidate): number {
  // published_at is guaranteed non-null on every candidate this ever
  // legitimately compares (both sides are already filtered to
  // status === "published" before reaching here, and publish_blog_post()
  // always sets published_at in the same transaction as the status
  // change -- migration 047) -- the `?? 0` only exists so a
  // theoretically malformed row can never throw during sort.
  const aTime = a.published_at ? new Date(a.published_at).getTime() : 0;
  const bTime = b.published_at ? new Date(b.published_at).getTime() : 0;
  return bTime - aTime;
}

// "latest published post where featured=true; if multiple, latest
// published_at wins." A draft with featured=true is never eligible --
// re-checked here, not merely assumed from the caller's own query.
export function selectFeaturedPost(candidates: BlogLandingCandidate[]): BlogLandingCandidate | null {
  const eligible = candidates.filter((p) => p.status === "published" && p.featured);
  if (eligible.length === 0) return null;
  return [...eligible].sort(byLatestPublishedFirst)[0];
}

// Latest published posts, excluding the featured post's id (if one was
// selected) so the same article never appears twice on the landing
// page.
export function selectLatestPosts(
  candidates: BlogLandingCandidate[],
  excludeId: string | null,
  limit: number = BLOG_LATEST_SECTION_LIMIT,
): BlogLandingCandidate[] {
  return candidates
    .filter((p) => p.status === "published" && p.id !== excludeId)
    .sort(byLatestPublishedFirst)
    .slice(0, limit);
}

// One category's own section -- published only, that category only,
// newest first, bounded.
export function selectCategoryPosts(
  candidates: BlogLandingCandidate[],
  category: BlogCategory,
  limit: number = BLOG_CATEGORY_SECTION_LIMIT,
): BlogLandingCandidate[] {
  return candidates
    .filter((p) => p.status === "published" && p.category === category)
    .sort(byLatestPublishedFirst)
    .slice(0, limit);
}

// Related reading on an article page: latest 3 published posts in the
// SAME category, excluding the current article itself. No AI
// recommendations, no manual relation table -- exactly this one rule.
export function selectRelatedPosts(
  candidates: BlogLandingCandidate[],
  category: BlogCategory,
  currentPostId: string,
  limit: number = BLOG_RELATED_POSTS_LIMIT,
): BlogLandingCandidate[] {
  return candidates
    .filter((p) => p.status === "published" && p.category === category && p.id !== currentPostId)
    .sort(byLatestPublishedFirst)
    .slice(0, limit);
}

// Whole-page empty state: true only when there is nothing at all to
// show anywhere on the page (no featured, no latest, every category
// section empty) -- the "brand new blog, zero articles yet" launch
// state this page must still look intentional for. A page with SOME
// content (even just one category populated) is not "empty" -- it
// simply omits whichever individual sections have nothing in them
// (handled by the page component itself skipping a section with an
// empty posts array), never a wall of empty headings.
export function isBlogLandingEmpty(params: {
  featured: BlogLandingCandidate | null;
  latest: BlogLandingCandidate[];
  categorySections: { posts: BlogLandingCandidate[] }[];
}): boolean {
  return (
    params.featured === null &&
    params.latest.length === 0 &&
    params.categorySections.every((section) => section.posts.length === 0)
  );
}
