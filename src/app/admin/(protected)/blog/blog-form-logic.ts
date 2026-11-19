import { isBlogCategory } from "@/lib/blog-categories";
import type { BlogCategory } from "@/lib/types";
import { fromMarkdown } from "mdast-util-from-markdown";

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
// bs4 (Renato 2026-11-17): hidden search keywords, typed in one box
// separated by commas; at most 10, each at most 40 characters. At least
// one is needed to publish (checked by publish_blog_post() and, for a
// post already live, update_blog_post()); a draft may have none.
export const KEYWORDS_MAX_COUNT = 10;
export const KEYWORD_MAX_LENGTH = 40;

// "vetë-botim,  Vetë-botim , self publishing,," -> ["vetë-botim",
// "self publishing"]: split on commas, trim, inner spaces collapsed,
// blanks dropped, repeats (ignoring capitals) dropped, first spelling
// kept. Never truncates: the caller rejects too many / too long.
export function parseKeywords(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const k = part.replace(/\s+/g, " ").trim();
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
  }
  return out;
}

export type BlogPostFieldInput = {
  title: string;
  slug: string;
  excerpt: string;
  contentMarkdown: string;
  category: string;
  featured: boolean;
  isEditorial: boolean;
  keywords: string;
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
  isEditorial: boolean;
  keywords: string[];
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

  const keywords = parseKeywords(input.keywords);
  if (keywords.length > KEYWORDS_MAX_COUNT) {
    return { ok: false, error: `Use at most ${KEYWORDS_MAX_COUNT} keywords.` };
  }
  if (keywords.some((k) => k.length > KEYWORD_MAX_LENGTH)) {
    return { ok: false, error: `Each keyword must be ${KEYWORD_MAX_LENGTH} characters or fewer.` };
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
      isEditorial: input.isEditorial,
      keywords,
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
    if ((error.message ?? "").includes("blog_posts_one_pin_idx")) {
      return "Another article was pinned at the same moment. Please try again.";
    }
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
    "a published article needs at least one keyword":
      "A live article needs at least one keyword. Add one in Keywords and save.",
    "too many keywords": `Use at most ${KEYWORDS_MAX_COUNT} keywords.`,
    "each keyword must be between 1 and 40 characters": `Each keyword must be ${KEYWORD_MAX_LENGTH} characters or fewer.`,
    "only a draft post can be deleted, or it does not exist":
      "Only draft articles can be deleted. Unpublish this article first.",
    "the go-live time must be in the future": "Pick a go-live time at least a few minutes from now.",
    "the go-live time must be within a year": "Pick a go-live time within the next year.",
    "only a draft that has never been live can be scheduled":
      "Only an article that has never been live can be scheduled. Use Publish instead.",
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

// e2 (Renato 2026-11-19): images inside an article come only from
// Librum's own blog storage (the Image button uploads them there). An
// image that was already in the saved article is still accepted, so an
// older post with an outside picture can still be saved.
//
// Finds every image address in the Markdown: inline ![alt](url "title")
// and reference style ![alt][ref] / ![alt][] / ![ref] with their
// [ref]: url definitions.
// Every image address in the Markdown, found with the same Markdown
// parser the article page renders with (react-markdown uses
// mdast-util-from-markdown through remark-parse), so the uploads-only
// check sees exactly the pictures a reader would see (audit A-r1 N1:
// a regex missed `![a [b]](url)`). Covers inline images and
// reference-style images with their definitions.
export function markdownImageUrls(markdown: string): string[] {
  const urls: string[] = [];
  const defs = new Map<string, string>();
  const refs: string[] = [];
  const walk = (node: MdNode) => {
    if (node.type === "image" && typeof node.url === "string") urls.push(node.url);
    else if (node.type === "imageReference" && typeof node.identifier === "string") refs.push(node.identifier);
    else if (node.type === "definition" && typeof node.identifier === "string" && typeof node.url === "string") {
      if (!defs.has(node.identifier)) defs.set(node.identifier, node.url);
    }
    if (node.children) for (const c of node.children) walk(c);
  };
  walk(fromMarkdown(markdown) as MdNode);
  for (const id of refs) {
    const url = defs.get(id);
    if (url !== undefined) urls.push(url);
  }
  return urls;
}

type MdNode = { type: string; url?: unknown; identifier?: unknown; children?: MdNode[] };

export function findDisallowedImageUrls(
  markdown: string,
  allowedPrefix: string,
  previousMarkdown: string | null,
): string[] {
  const previous = new Set(previousMarkdown ? markdownImageUrls(previousMarkdown) : []);
  return markdownImageUrls(markdown).filter(
    (url) => !(url.startsWith(allowedPrefix) && !url.includes("..")) && !previous.has(url),
  );
}

export const OUTSIDE_IMAGE_ERROR =
  "Images must be uploaded with the Image button. Remove the picture linked from another website and add it again with Image.";
