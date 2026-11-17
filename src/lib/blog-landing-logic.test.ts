import { describe, expect, it } from "vitest";
import {
  BLOG_CATEGORY_PAGE_SIZE,
  blogCategoryPageCount,
  blogCategoryPageRange,
  isBlogLandingEmpty,
  parseBlogPageParam,
  selectCategoryPosts,
  selectFeaturedPost,
  selectLatestPosts,
  selectRelatedPosts,
  type BlogLandingCandidate,
} from "./blog-landing-logic";

function post(overrides: Partial<BlogLandingCandidate> & { id: string }): BlogLandingCandidate {
  return {
    slug: overrides.id,
    title: `Post ${overrides.id}`,
    excerpt: "Excerpt",
    category: "zeja",
    cover_image_path: null,
    published_at: "2026-01-01T00:00:00Z",
    status: "published",
    featured: false,
    ...overrides,
  };
}

describe("selectFeaturedPost", () => {
  it("returns null when no post is featured", () => {
    const candidates = [post({ id: "a" }), post({ id: "b" })];
    expect(selectFeaturedPost(candidates)).toBeNull();
  });

  it("returns the one featured post", () => {
    const candidates = [post({ id: "a" }), post({ id: "b", featured: true })];
    expect(selectFeaturedPost(candidates)?.id).toBe("b");
  });

  it("when multiple are featured, the latest published_at wins", () => {
    const candidates = [
      post({ id: "old", featured: true, published_at: "2026-01-01T00:00:00Z" }),
      post({ id: "new", featured: true, published_at: "2026-06-01T00:00:00Z" }),
      post({ id: "mid", featured: true, published_at: "2026-03-01T00:00:00Z" }),
    ];
    expect(selectFeaturedPost(candidates)?.id).toBe("new");
  });

  it("ignores an unpublished (draft) post even if featured=true", () => {
    const candidates = [post({ id: "draft-featured", status: "draft", featured: true })];
    expect(selectFeaturedPost(candidates)).toBeNull();
  });

  it("a published, non-featured post never wins over an unpublished featured one -- both correctly excluded/included", () => {
    const candidates = [
      post({ id: "draft-featured", status: "draft", featured: true, published_at: "2026-06-01T00:00:00Z" }),
      post({ id: "published-featured", status: "published", featured: true, published_at: "2026-01-01T00:00:00Z" }),
    ];
    expect(selectFeaturedPost(candidates)?.id).toBe("published-featured");
  });
});

describe("selectLatestPosts", () => {
  it("returns published posts newest first", () => {
    const candidates = [
      post({ id: "old", published_at: "2026-01-01T00:00:00Z" }),
      post({ id: "new", published_at: "2026-06-01T00:00:00Z" }),
    ];
    expect(selectLatestPosts(candidates, null).map((p) => p.id)).toEqual(["new", "old"]);
  });

  it("excludes the featured post's id when one is provided", () => {
    const candidates = [
      post({ id: "featured", published_at: "2026-06-01T00:00:00Z", featured: true }),
      post({ id: "other", published_at: "2026-01-01T00:00:00Z" }),
    ];
    const latest = selectLatestPosts(candidates, "featured");
    expect(latest.map((p) => p.id)).toEqual(["other"]);
  });

  it("excludes draft posts", () => {
    const candidates = [post({ id: "draft", status: "draft" }), post({ id: "pub" })];
    expect(selectLatestPosts(candidates, null).map((p) => p.id)).toEqual(["pub"]);
  });

  it("respects the limit", () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      post({ id: `p${i}`, published_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z` }),
    );
    expect(selectLatestPosts(candidates, null, 3)).toHaveLength(3);
  });
});

describe("selectCategoryPosts", () => {
  it("returns only published posts from the given category, newest first", () => {
    const candidates = [
      post({ id: "writing-old", category: "zeja", published_at: "2026-01-01T00:00:00Z" }),
      post({ id: "writing-new", category: "zeja", published_at: "2026-06-01T00:00:00Z" }),
      post({ id: "publishing-1", category: "tregu" }),
      post({ id: "draft-writing", category: "zeja", status: "draft" }),
    ];
    const result = selectCategoryPosts(candidates, "zeja");
    expect(result.map((p) => p.id)).toEqual(["writing-new", "writing-old"]);
  });

  it("returns an empty array for a category with no published posts", () => {
    expect(selectCategoryPosts([post({ id: "a", category: "zeja" })], "tregu")).toEqual([]);
  });

  it("respects the limit", () => {
    const candidates = Array.from({ length: 5 }, (_, i) => post({ id: `p${i}`, category: "tregu" }));
    expect(selectCategoryPosts(candidates, "tregu", 2)).toHaveLength(2);
  });
});

describe("selectRelatedPosts", () => {
  it("returns latest 3 published posts in the same category, excluding the current post", () => {
    const candidates = [
      post({ id: "current", category: "zeja" }),
      post({ id: "a", category: "zeja", published_at: "2026-05-01T00:00:00Z" }),
      post({ id: "b", category: "zeja", published_at: "2026-04-01T00:00:00Z" }),
      post({ id: "c", category: "zeja", published_at: "2026-03-01T00:00:00Z" }),
      post({ id: "d", category: "zeja", published_at: "2026-02-01T00:00:00Z" }),
      post({ id: "other-category", category: "tregu", published_at: "2026-06-01T00:00:00Z" }),
    ];
    const result = selectRelatedPosts(candidates, "zeja", "current");
    expect(result).toHaveLength(3);
    expect(result.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(result.some((p) => p.id === "current")).toBe(false);
    expect(result.some((p) => p.id === "other-category")).toBe(false);
  });

  it("excludes draft posts from the same category", () => {
    const candidates = [
      post({ id: "current", category: "zeja" }),
      post({ id: "draft", category: "zeja", status: "draft" }),
    ];
    expect(selectRelatedPosts(candidates, "zeja", "current")).toEqual([]);
  });

  it("returns fewer than 3 without error when fewer exist", () => {
    const candidates = [
      post({ id: "current", category: "zeja" }),
      post({ id: "only-other", category: "zeja" }),
    ];
    const result = selectRelatedPosts(candidates, "zeja", "current");
    expect(result).toHaveLength(1);
  });

  it("returns an empty array when no related posts exist", () => {
    const candidates = [post({ id: "current", category: "zeja" })];
    expect(selectRelatedPosts(candidates, "zeja", "current")).toEqual([]);
  });
});

describe("isBlogLandingEmpty", () => {
  it("is true when there is no featured post, no latest posts, and every category is empty", () => {
    expect(
      isBlogLandingEmpty({
        featured: null,
        latest: [],
        categorySections: [{ posts: [] }, { posts: [] }, { posts: [] }, { posts: [] }],
      }),
    ).toBe(true);
  });

  it("is false when a featured post exists", () => {
    expect(
      isBlogLandingEmpty({
        featured: post({ id: "a" }),
        latest: [],
        categorySections: [{ posts: [] }],
      }),
    ).toBe(false);
  });

  it("is false when latest has posts even with no featured post", () => {
    expect(
      isBlogLandingEmpty({
        featured: null,
        latest: [post({ id: "a" })],
        categorySections: [{ posts: [] }],
      }),
    ).toBe(false);
  });

  it("is false when only one category section has posts", () => {
    expect(
      isBlogLandingEmpty({
        featured: null,
        latest: [],
        categorySections: [{ posts: [post({ id: "a" })] }, { posts: [] }],
      }),
    ).toBe(false);
  });
});

describe("category page paging", () => {
  it("parseBlogPageParam: missing is 1, plain whole numbers pass, anything else is null", () => {
    expect(parseBlogPageParam(undefined)).toBe(1);
    expect(parseBlogPageParam("1")).toBe(1);
    expect(parseBlogPageParam("12")).toBe(12);
    for (const bad of ["0", "-1", "2.5", "abc", "01", "", "1e3", "999999", ["2"]]) {
      expect(parseBlogPageParam(bad)).toBeNull();
    }
  });

  it("blogCategoryPageRange: 12 per page, inclusive", () => {
    expect(BLOG_CATEGORY_PAGE_SIZE).toBe(12);
    expect(blogCategoryPageRange(1)).toEqual({ from: 0, to: 11 });
    expect(blogCategoryPageRange(3)).toEqual({ from: 24, to: 35 });
  });

  it("blogCategoryPageCount: at least 1", () => {
    expect(blogCategoryPageCount(0)).toBe(1);
    expect(blogCategoryPageCount(12)).toBe(1);
    expect(blogCategoryPageCount(13)).toBe(2);
  });
});
