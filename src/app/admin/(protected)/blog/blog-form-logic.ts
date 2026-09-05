import { isBlogCategory } from "@/lib/blog-categories";
import type { BlogCategory } from "@/lib/types";

// LIBRUM 2.0 BLOG-1C: mirrors migration 047's own CHECK constraints and
// RPC-level length validation exactly (see that migration's own
// header) -- a value that passes here can never fail at the database
// layer, matching the exact convention already established for books
// (src/app/(public)/dashboard/books/actions.ts's own bounded-length
// helpers).
export const TITLE_MAX_LENGTH = 200;
export const SLUG_MAX_LENGTH = 200;
export const EXCERPT_MAX_LENGTH = 500;
export const CONTENT_MARKDOWN_MAX_LENGTH = 50000;
export const SEO_TITLE_MAX_LENGTH = 70;
export const SEO_DESCRIPTION_MAX_LENGTH = 160;

export type BlogPostFieldInput = {
  title: string;
  slug: string;
  excerpt: string;
  contentMarkdown: string;
  category: string;
  featured: boolean;
  seoTitle: string;
  seoDescription: string;
};

export type ValidatedBlogPostFields = {
  title: string;
  slug: string;
  excerpt: string;
  contentMarkdown: string;
  category: BlogCategory;
  featured: boolean;
  seoTitle: string | null;
  seoDescription: string | null;
};

export type BlogValidationResult =
  | { ok: true; value: ValidatedBlogPostFields }
  | { ok: false; error: string };

// Application-layer mirror of the RPCs' own validation -- a UX nicety
// (a specific, per-field redirect error without a round trip), never
// the actual security boundary. create_blog_post()/update_blog_post()
// re-validate every one of these same rules server-side regardless
// (see migration 047), so a bug here can make the form less pleasant to
// use but can never let an invalid row reach the database.
export function validateBlogPostFields(input: BlogPostFieldInput): BlogValidationResult {
  const title = input.title.trim();
  if (!title) return { ok: false, error: "Title is required." };
  if (title.length > TITLE_MAX_LENGTH) {
    return { ok: false, error: `Title must be ${TITLE_MAX_LENGTH} characters or fewer.` };
  }

  const slug = input.slug.trim();
  if (!slug) return { ok: false, error: "Slug is required." };
  if (slug.length > SLUG_MAX_LENGTH) {
    return { ok: false, error: `Slug must be ${SLUG_MAX_LENGTH} characters or fewer.` };
  }

  const excerpt = input.excerpt.trim();
  if (!excerpt) return { ok: false, error: "Excerpt is required." };
  if (excerpt.length > EXCERPT_MAX_LENGTH) {
    return { ok: false, error: `Excerpt must be ${EXCERPT_MAX_LENGTH} characters or fewer.` };
  }

  const contentMarkdown = input.contentMarkdown.trim();
  if (!contentMarkdown) return { ok: false, error: "Content is required." };
  if (contentMarkdown.length > CONTENT_MARKDOWN_MAX_LENGTH) {
    return {
      ok: false,
      error: `Content must be ${CONTENT_MARKDOWN_MAX_LENGTH.toLocaleString()} characters or fewer.`,
    };
  }

  if (!isBlogCategory(input.category)) {
    return { ok: false, error: "Please choose a valid category." };
  }

  const seoTitle = input.seoTitle.trim();
  if (seoTitle.length > SEO_TITLE_MAX_LENGTH) {
    return { ok: false, error: `SEO title must be ${SEO_TITLE_MAX_LENGTH} characters or fewer.` };
  }

  const seoDescription = input.seoDescription.trim();
  if (seoDescription.length > SEO_DESCRIPTION_MAX_LENGTH) {
    return {
      ok: false,
      error: `SEO description must be ${SEO_DESCRIPTION_MAX_LENGTH} characters or fewer.`,
    };
  }

  return {
    ok: true,
    value: {
      title,
      slug,
      excerpt,
      contentMarkdown,
      category: input.category,
      featured: input.featured,
      seoTitle: seoTitle || null,
      seoDescription: seoDescription || null,
    },
  };
}

// Maps every expected error this codebase's own five blog RPCs
// (migration 047) can raise, plus the one raw Postgres error class
// (unique_violation on the slug column) that can reach here despite the
// application-layer check above, into a message safe to show staff
// directly -- never raw SQL/Postgres/Supabase internals. An unmapped
// message falls through to a generic fallback rather than ever being
// echoed verbatim, so a future, unanticipated database error can never
// leak internals through this path.
export function mapBlogRpcError(error: { message?: string; code?: string } | null | undefined): string {
  if (!error) return "Something went wrong. Please try again.";

  // Postgres unique_violation -- only reachable on the slug column here
  // (the only UNIQUE constraint blog_posts has), surfaced by either
  // create_blog_post() or update_blog_post().
  if (error.code === "23505") {
    return "That URL slug is already in use. Please choose a different one.";
  }

  const KNOWN_MESSAGES: Record<string, string> = {
    "not authorized": "You don't have permission to do that.",
    "invalid category": "Please choose a valid category.",
    "no such blog post": "That article could not be found.",
    "slug is immutable once a post is published":
      "The URL slug can't be changed once an article is published.",
    "no publishable draft found for this id":
      "That article can't be published right now -- it may already be published.",
    "no published post found for this id":
      "That article can't be unpublished right now -- it may already be a draft.",
    "only a draft post can be deleted, or it does not exist":
      "Only draft articles can be deleted. Unpublish this article first.",
  };

  const message = error.message ?? "";
  if (message in KNOWN_MESSAGES) return KNOWN_MESSAGES[message];

  // The five length/required-field messages the RPCs themselves raise
  // (e.g. "title must be between 1 and 200 characters") are already
  // hand-written, plain-English, and safe -- passed through directly
  // rather than duplicated in KNOWN_MESSAGES above, since they never
  // mention a table, column, or SQL construct.
  if (/^(title|slug|excerpt|content_markdown|seo_title|seo_description) (must|is)/.test(message)) {
    return message;
  }

  return "Something went wrong. Please try again.";
}

export const NOT_AUTHENTICATED_RPC_MESSAGE = "not authenticated";
