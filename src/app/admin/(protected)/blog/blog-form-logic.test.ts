import { describe, expect, it } from "vitest";
import {
  CONTENT_MARKDOWN_MAX_LENGTH,
  EXCERPT_MAX_LENGTH,
  SEO_DESCRIPTION_MAX_LENGTH,
  SEO_TITLE_MAX_LENGTH,
  SLUG_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  findDisallowedImageUrls,
  mapBlogRpcError,
  markdownImageUrls,
  validateBlogPostFields,
  parseKeywords,
  KEYWORDS_MAX_COUNT,
  KEYWORD_MAX_LENGTH,
  type BlogPostFieldInput,
} from "./blog-form-logic";

function validInput(overrides: Partial<BlogPostFieldInput> = {}): BlogPostFieldInput {
  return {
    title: "How to publish an ebook",
    slug: "how-to-publish-an-ebook",
    excerpt: "A short excerpt.",
    contentMarkdown: "Some article body content.",
    category: "tregu",
    featured: false,
    isEditorial: false,
    keywords: "",
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

  it("rejects the blank first choice and the four old categories", () => {
    for (const category of ["", "publishing", "writing", "authors-books", "librum-guides"]) {
      expect(validateBlogPostFields(validInput({ category }))).toEqual({
        ok: false,
        error: "Please choose a valid category.",
      });
    }
  });

  it("accepts every one of the five categories and rejects editorial (bs1: a tick, not a category)", () => {
    for (const category of ["zeja", "tregu", "kultura", "reflektime", "vleresime"]) {
      expect(validateBlogPostFields(validInput({ category })).ok).toBe(true);
    }
    expect(validateBlogPostFields(validInput({ category: "editorial" }))).toEqual({
      ok: false,
      error: "Please choose a valid category.",
    });
  });

  it("passes the Editorial tick through", () => {
    const result = validateBlogPostFields(validInput({ isEditorial: true }));
    expect(result.ok && result.value.isEditorial).toBe(true);
  });

  it("bs4: keywords are split on commas, trimmed, de-duplicated (ignoring capitals), blanks dropped", () => {
    expect(parseKeywords("vetë-botim,  Vetë-botim , self   publishing,, ,e-libër")).toEqual([
      "vetë-botim",
      "self publishing",
      "e-libër",
    ]);
    expect(parseKeywords("")).toEqual([]);
    const result = validateBlogPostFields(validInput({ keywords: " a, b ,a" }));
    expect(result.ok && result.value.keywords).toEqual(["a", "b"]);
  });

  it("bs4: no keywords is fine for a draft (the database checks publishing)", () => {
    const result = validateBlogPostFields(validInput({ keywords: "" }));
    expect(result.ok && result.value.keywords).toEqual([]);
  });

  it("bs4: rejects more than 10 keywords and a keyword over 40 characters", () => {
    const eleven = Array.from({ length: KEYWORDS_MAX_COUNT + 1 }, (_, i) => `k${i}`).join(",");
    expect(validateBlogPostFields(validInput({ keywords: eleven }))).toEqual({
      ok: false,
      error: "Use at most 10 keywords.",
    });
    const ten = Array.from({ length: KEYWORDS_MAX_COUNT }, (_, i) => `k${i}`).join(",");
    expect(validateBlogPostFields(validInput({ keywords: ten })).ok).toBe(true);
    expect(validateBlogPostFields(validInput({ keywords: "a".repeat(KEYWORD_MAX_LENGTH + 1) }))).toEqual({
      ok: false,
      error: "Each keyword must be 40 characters or fewer.",
    });
    expect(validateBlogPostFields(validInput({ keywords: "a".repeat(KEYWORD_MAX_LENGTH) })).ok).toBe(true);
  });

  it("maps the database's keyword errors to plain staff messages", () => {
    expect(mapBlogRpcError({ message: "a published article needs at least one keyword" })).toBe(
      "A live article needs at least one keyword. Add one in Keywords and save.",
    );
    expect(mapBlogRpcError({ message: "too many keywords" })).toBe("Use at most 10 keywords.");
    expect(mapBlogRpcError({ message: "each keyword must be between 1 and 40 characters" })).toBe(
      "Each keyword must be 40 characters or fewer.",
    );
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

describe("markdownImageUrls / findDisallowedImageUrls (e2)", () => {
  const BLOG = "https://ref.supabase.co/storage/v1/object/public/blog/";
  it("finds inline and reference images, not plain links", () => {
    const md = [
      `![a](${BLOG}inline/1.jpg "Caption")`,
      "![b](<https://x.test/b.png>)",
      "[a link](https://x.test/page)",
      "![c][pic] and ![pic2] and ![d][]",
      "[pic]: https://x.test/c.png",
      "[pic2]: https://x.test/c2.png 'title'",
      "[d]: https://x.test/d.png",
    ].join("\n\n"); // a definition cannot interrupt a paragraph
    expect(markdownImageUrls(md)).toEqual([
      `${BLOG}inline/1.jpg`,
      "https://x.test/b.png",
      "https://x.test/c.png",
      "https://x.test/c2.png",
      "https://x.test/d.png",
    ]);
  });
  it("blocks new outside images, keeps Librum's and ones already saved", () => {
    const previous = "![old](https://old.test/a.jpg)";
    const md = `![old](https://old.test/a.jpg)\n![ok](${BLOG}inline/2.jpg)\n![new](https://new.test/b.jpg)`;
    expect(findDisallowedImageUrls(md, BLOG, previous)).toEqual(["https://new.test/b.jpg"]);
    expect(findDisallowedImageUrls(md, BLOG, null)).toEqual(["https://old.test/a.jpg", "https://new.test/b.jpg"]);
    expect(findDisallowedImageUrls(`![x](${BLOG}../avatars/a.jpg)`, BLOG, null)).toEqual([`${BLOG}../avatars/a.jpg`]);
  });
  it("reads Markdown like the article page does (audit A-r1 N1)", () => {
    // Brackets inside the alt text, an image inside a link, odd spacing,
    // and a case-insensitive reference label are all still found.
    expect(markdownImageUrls("![a [b]](https://evil.test/x.png)")).toEqual(["https://evil.test/x.png"]);
    expect(markdownImageUrls("[![a](https://evil.test/y.png)](https://x.test)")).toEqual(["https://evil.test/y.png"]);
    expect(markdownImageUrls("![a]( https://evil.test/z.png )")).toEqual(["https://evil.test/z.png"]);
    expect(markdownImageUrls("![a][PIC]\n\n[pic]: https://evil.test/r.png")).toEqual(["https://evil.test/r.png"]);
    // Code is shown as text, not as a picture, so it is not an image.
    expect(markdownImageUrls("`![a](https://x.test/c.png)`\n\n    ![b](https://x.test/d.png)")).toEqual([]);
    expect(findDisallowedImageUrls("![a [b]](https://evil.test/x.png)", BLOG, null)).toEqual(["https://evil.test/x.png"]);
  });
});

describe("mapBlogRpcError: pin and schedule messages", () => {
  it("maps the new database messages", () => {
    expect(mapBlogRpcError({ message: "the go-live time must be in the future" })).toMatch(/at least a few minutes/);
    expect(mapBlogRpcError({ message: "only a draft that has never been live can be scheduled" })).toMatch(/Use Publish/);
    expect(mapBlogRpcError({ code: "23505", message: 'duplicate key value violates unique constraint "blog_posts_one_pin_idx"' })).toMatch(/pinned at the same moment/);
    expect(mapBlogRpcError({ code: "23505", message: 'duplicate key value violates unique constraint "blog_posts_slug_key"' })).toMatch(/slug is already in use/);
  });
});
