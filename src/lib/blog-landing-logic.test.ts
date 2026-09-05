import { describe, expect, it } from "vitest";
import {
  isBlogLandingEmpty,
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
    category: "writing",
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
      post({ id: "writing-old", category: "writing", published_at: "2026-01-01T00:00:00Z" }),
      post({ id: "writing-new", category: "writing", published_at: "2026-06-01T00:00:00Z" }),
      post({ id: "publishing-1", category: "publishing" }),
      post({ id: "draft-writing", category: "writing", status: "draft" }),
    ];
    const result = selectCategoryPosts(candidates, "writing");
    expect(result.map((p) => p.id)).toEqual(["writing-new", "writing-old"]);
  });

  it("returns an empty array for a category with no published posts", () => {
    expect(selectCategoryPosts([post({ id: "a", category: "writing" })], "publishing")).toEqual([]);
  });

  it("respects the limit", () => {
    const candidates = Array.from({ length: 5 }, (_, i) => post({ id: `p${i}`, category: "publishing" }));
    expect(selectCategoryPosts(candidates, "publishing", 2)).toHaveLength(2);
  });
});

describe("selectRelatedPosts", () => {
  it("returns latest 3 published posts in the same category, excluding the current post", () => {
    const candidates = [
      post({ id: "current", category: "writing" }),
      post({ id: "a", category: "writing", published_at: "2026-05-01T00:00:00Z" }),
      post({ id: "b", category: "writing", published_at: "2026-04-01T00:00:00Z" }),
      post({ id: "c", category: "writing", published_at: "2026-03-01T00:00:00Z" }),
      post({ id: "d", category: "writing", published_at: "2026-02-01T00:00:00Z" }),
      post({ id: "other-category", category: "publishing", published_at: "2026-06-01T00:00:00Z" }),
    ];
    const result = selectRelatedPosts(candidates, "writing", "current");
    expect(result).toHaveLength(3);
    expect(result.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(result.some((p) => p.id === "current")).toBe(false);
    expect(result.some((p) => p.id === "other-category")).toBe(false);
  });

  it("excludes draft posts from the same category", () => {
    const candidates = [
      post({ id: "current", category: "writing" }),
      post({ id: "draft", category: "writing", status: "draft" }),
    ];
    expect(selectRelatedPosts(candidates, "writing", "current")).toEqual([]);
  });

  it("returns fewer than 3 without error when fewer exist", () => {
    const candidates = [
      post({ id: "current", category: "writing" }),
      post({ id: "only-other", category: "writing" }),
    ];
    const result = selectRelatedPosts(candidates, "writing", "current");
    expect(result).toHaveLength(1);
  });

  it("returns an empty array when no related posts exist", () => {
    const candidates = [post({ id: "current", category: "writing" })];
    expect(selectRelatedPosts(candidates, "writing", "current")).toEqual([]);
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
