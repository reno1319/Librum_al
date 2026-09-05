import { describe, expect, it } from "vitest";
import { resolveAutoSlug, slugify } from "./blog-slug";

describe("slugify", () => {
  it("matches the BLOG-1 design brief's own worked example", () => {
    expect(slugify("Çfarë është EPUB?")).toBe("cfare-eshte-epub");
  });

  it("transliterates every Albanian e-with-diaeresis to a plain e", () => {
    expect(slugify("Përshtypje")).toBe("pershtypje");
  });

  it("transliterates every Albanian c-with-cedilla to a plain c", () => {
    expect(slugify("Çmimi i librit")).toBe("cmimi-i-librit");
  });

  it("lowercases the result", () => {
    expect(slugify("HOW TO PUBLISH")).toBe("how-to-publish");
  });

  it("converts spaces to hyphens", () => {
    expect(slugify("how to publish a book")).toBe("how-to-publish-a-book");
  });

  it("collapses repeated hyphens/spaces into a single hyphen", () => {
    expect(slugify("how   to--publish")).toBe("how-to-publish");
  });

  it("removes unsafe punctuation", () => {
    expect(slugify("What's an ISBN? (a guide)")).toBe("what-s-an-isbn-a-guide");
  });

  it("trims leading/trailing hyphens produced by leading/trailing punctuation or whitespace", () => {
    expect(slugify("  -- Hello World! -- ")).toBe("hello-world");
  });

  it("preserves plain Latin letters and numbers", () => {
    expect(slugify("Top 10 tips for 2026")).toBe("top-10-tips-for-2026");
  });

  it("returns an empty string for empty input", () => {
    expect(slugify("")).toBe("");
  });

  it("returns an empty string for input that is entirely punctuation/whitespace", () => {
    expect(slugify("   ???!!!   ")).toBe("");
  });

  it("does not decompose an accented Latin letter into a stray hyphen (NFD combining-mark strip)", () => {
    expect(slugify("Café culture")).toBe("cafe-culture");
  });
});

describe("resolveAutoSlug", () => {
  it("auto-generates from the title for a fresh, never-touched draft slug", () => {
    const result = resolveAutoSlug({
      currentSlug: "how-to-publish",
      title: "How to Publish a Book",
      slugTouched: false,
      slugReadOnly: false,
    });
    expect(result).toBe("how-to-publish-a-book");
  });

  it("stops auto-generating once the slug field has been manually touched", () => {
    const result = resolveAutoSlug({
      currentSlug: "my-custom-slug",
      title: "A Completely Different Title",
      slugTouched: true,
      slugReadOnly: false,
    });
    expect(result).toBe("my-custom-slug");
  });

  it("never auto-generates once the slug is read-only (a published post)", () => {
    const result = resolveAutoSlug({
      currentSlug: "original-published-slug",
      title: "An Edited Title",
      slugTouched: false,
      slugReadOnly: true,
    });
    expect(result).toBe("original-published-slug");
  });

  it("read-only wins even if the slug was never manually touched", () => {
    const result = resolveAutoSlug({
      currentSlug: "keep-me",
      title: "New Title",
      slugTouched: false,
      slugReadOnly: true,
    });
    expect(result).toBe("keep-me");
  });
});
