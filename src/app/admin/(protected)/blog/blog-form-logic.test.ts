import { describe, expect, it } from "vitest";
import {
  CONTENT_MARKDOWN_MAX_LENGTH,
  EXCERPT_MAX_LENGTH,
  SEO_DESCRIPTION_MAX_LENGTH,
  SEO_TITLE_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  mapBlogRpcError,
  validateBlogPostFields,
  type BlogPostFieldInput,
} from "./blog-form-logic";

function validInput(overrides: Partial<BlogPostFieldInput> = {}): BlogPostFieldInput {
  return {
    title: "How to publish an ebook",
    slug: "how-to-publish-an-ebook",
    excerpt: "A short excerpt.",
    contentMarkdown: "Some article body content.",
    category: "publishing",
    featured: false,
    seoTitle: "",
    seoDescription: "",
    ...overrides,
  };
}

describe("validateBlogPostFields", () => {
  it("accepts a fully valid input", () => {
    const result = validateBlogPostFields(validInput());
    expect(result.ok).toBe(true);
  });

  it("trims every text field", () => {
    const result = validateBlogPostFields(
      validInput({ title: "  Title  ", excerpt: "  Excerpt  ", contentMarkdown: "  Body  " }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Title");
      expect(result.value.excerpt).toBe("Excerpt");
      expect(result.value.contentMarkdown).toBe("Body");
    }
  });

  it("rejects an empty title", () => {
    const result = validateBlogPostFields(validInput({ title: "" }));
    expect(result).toEqual({ ok: false, error: "Title is required." });
  });

  it("rejects a title over the max length", () => {
    const result = validateBlogPostFields(validInput({ title: "a".repeat(TITLE_MAX_LENGTH + 1) }));
    expect(result.ok).toBe(false);
  });

  it("accepts a title at exactly the max length", () => {
    const result = validateBlogPostFields(validInput({ title: "a".repeat(TITLE_MAX_LENGTH) }));
    expect(result.ok).toBe(true);
  });

  it("rejects an empty slug", () => {
    const result = validateBlogPostFields(validInput({ slug: "" }));
    expect(result).toEqual({ ok: false, error: "Slug is required." });
  });

  it("rejects a slug over the max length", () => {
    const result = validateBlogPostFields(validInput({ slug: "a".repeat(SLUG_MAX_LENGTH + 1) }));
    expect(result.ok).toBe(false);
  });

  it("rejects an empty excerpt", () => {
    const result = validateBlogPostFields(validInput({ excerpt: "" }));
    expect(result).toEqual({ ok: false, error: "Excerpt is required." });
  });

  it("rejects an excerpt over the max length", () => {
    const result = validateBlogPostFields(validInput({ excerpt: "a".repeat(EXCERPT_MAX_LENGTH + 1) }));
    expect(result.ok).toBe(false);
  });

  it("rejects empty content", () => {
    const result = validateBlogPostFields(validInput({ contentMarkdown: "" }));
    expect(result).toEqual({ ok: false, error: "Content is required." });
  });

  it("rejects content over the max length", () => {
    const result = validateBlogPostFields(
      validInput({ contentMarkdown: "a".repeat(CONTENT_MARKDOWN_MAX_LENGTH + 1) }),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects an invalid category", () => {
    const result = validateBlogPostFields(validInput({ category: "not-a-real-category" }));
    expect(result).toEqual({ ok: false, error: "Please choose a valid category." });
  });

  it("accepts every one of the four approved categories", () => {
    for (const category of ["publishing", "writing", "authors-books", "librum-guides"]) {
      expect(validateBlogPostFields(validInput({ category })).ok).toBe(true);
    }
  });

  it("rejects an seo title over the max length", () => {
    const result = validateBlogPostFields(validInput({ seoTitle: "a".repeat(SEO_TITLE_MAX_LENGTH + 1) }));
    expect(result.ok).toBe(false);
  });

  it("rejects an seo description over the max length", () => {
    const result = validateBlogPostFields(
      validInput({ seoDescription: "a".repeat(SEO_DESCRIPTION_MAX_LENGTH + 1) }),
    );
    expect(result.ok).toBe(false);
  });

  it("normalizes empty optional SEO fields to null", () => {
    const result = validateBlogPostFields(validInput({ seoTitle: "  ", seoDescription: "" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.seoTitle).toBeNull();
      expect(result.value.seoDescription).toBeNull();
    }
  });

  it("preserves a real, present SEO title/description", () => {
    const result = validateBlogPostFields(
      validInput({ seoTitle: "SEO Title", seoDescription: "SEO description" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.seoTitle).toBe("SEO Title");
      expect(result.value.seoDescription).toBe("SEO description");
    }
  });

  it("allows Albanian Unicode and literary punctuation in title/excerpt/content", () => {
    const result = validateBlogPostFields(
      validInput({
        title: "Çfarë është ISBN-ja? Një udhëzues i shkurtër.",
        excerpt: "Përgjigje e shpejtë — me shembuj konkretë!",
        contentMarkdown: "Teksti përmban shenja pikësimi: thonjëza, em-dash — dhe pikëpyetje?",
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe("mapBlogRpcError", () => {
  it("maps a unique_violation (duplicate slug) to a friendly message", () => {
    expect(mapBlogRpcError({ code: "23505", message: "duplicate key value" })).toBe(
      "That URL slug is already in use. Please choose a different one.",
    );
  });

  it("maps 'not authorized' to a friendly message", () => {
    expect(mapBlogRpcError({ message: "not authorized" })).toBe(
      "You don't have permission to do that.",
    );
  });

  it("maps 'slug is immutable once a post is published' to a friendly message", () => {
    expect(mapBlogRpcError({ message: "slug is immutable once a post is published" })).toBe(
      "The URL slug can't be changed once an article is published.",
    );
  });

  it("maps 'no publishable draft found for this id' to a friendly message", () => {
    expect(mapBlogRpcError({ message: "no publishable draft found for this id" })).toContain(
      "already be published",
    );
  });

  it("maps 'no published post found for this id' to a friendly message", () => {
    expect(mapBlogRpcError({ message: "no published post found for this id" })).toContain(
      "already be a draft",
    );
  });

  it("maps the delete-published-post rejection to a friendly message", () => {
    expect(
      mapBlogRpcError({ message: "only a draft post can be deleted, or it does not exist" }),
    ).toBe("Only draft articles can be deleted. Unpublish this article first.");
  });

  it("maps 'no such blog post' to a friendly message", () => {
    expect(mapBlogRpcError({ message: "no such blog post" })).toBe(
      "That article could not be found.",
    );
  });

  it("passes through the RPC's own hand-written length-validation messages", () => {
    expect(mapBlogRpcError({ message: "title must be between 1 and 200 characters" })).toBe(
      "title must be between 1 and 200 characters",
    );
  });

  it("never leaks a raw/unexpected Postgres error verbatim", () => {
    expect(
      mapBlogRpcError({ message: 'relation "blog_posts" violates foreign key constraint "xyz"' }),
    ).toBe("Something went wrong. Please try again.");
  });

  it("handles a null/undefined error safely", () => {
    expect(mapBlogRpcError(null)).toBe("Something went wrong. Please try again.");
    expect(mapBlogRpcError(undefined)).toBe("Something went wrong. Please try again.");
  });
});
