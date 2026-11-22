import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BlogMarkdown } from "@/components/blog-markdown";
import { blogDocToMarkdown, blogEditorExtensions, blogMarkdownToDoc } from "./blog-editor-markdown";
import {
  cleanLinkSearchTerm,
  foldForSearch,
  isAllowedBlogHref,
  isLibrumHref,
  opensInNewTab,
  shortBlogHref,
  typedTextToHref,
} from "./blog-links";

// Blog links (Renato 2026-11-22, lk1 c, lk3 a).
describe("isAllowedBlogHref", () => {
  it.each(["https://example.com", "http://example.com/a?b=1#c", "/libra/123", "/blog/si-te-shkruash", "mailto:info@librum.al", "#pjesa"])(
    "accepts %s",
    (href) => expect(isAllowedBlogHref(href)).toBe(true),
  );
  it.each([
    "",
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,x",
    "//evil.example",
    "/\\evil.example",
    "https://",
    "https://localhost",
    "https://a b.com",
    "ftp://example.com",
    "libra/123",
    "mailto:",
    "tel:123",
    "\\\\evil.example",
  ])("refuses %s", (href) => expect(isAllowedBlogHref(href)).toBe(false));
});

describe("typedTextToHref", () => {
  it("keeps full and Librum addresses as typed", () => {
    expect(typedTextToHref(" https://example.com/x ")).toBe("https://example.com/x");
    expect(typedTextToHref("/autore/abc")).toBe("/autore/abc");
  });
  it("adds https:// to a bare address", () => {
    expect(typedTextToHref("example.com/udhezues")).toBe("https://example.com/udhezues");
    expect(typedTextToHref("www.example.al")).toBe("https://www.example.al");
  });
  it("treats words as a search, not an address", () => {
    expect(typedTextToHref("plan")).toBeNull();
    expect(typedTextToHref("plani i madh")).toBeNull();
    expect(typedTextToHref("javascript:alert(1)")).toBeNull();
  });
});

describe("isLibrumHref (lk3 a: same tab)", () => {
  it.each(["/libra/1", "#pjesa", "https://librum.al/blog/x", "https://www.librum.al", "http://LIBRUM.AL/x"])("%s is Librum", (h) =>
    expect(isLibrumHref(h)).toBe(true),
  );
  it.each(["https://example.com", "https://librum.al.evil.com", "https://notlibrum.al", "//librum.al", "mailto:a@b.al"])(
    "%s is outside",
    (h) => expect(isLibrumHref(h)).toBe(false),
  );
});

describe("opensInNewTab (lk3 a, audit LINK-r1 F2)", () => {
  it("only outside web addresses", () => {
    expect(opensInNewTab("https://example.com")).toBe(true);
    for (const h of ["mailto:info@librum.al", "/libra/1", "#x", "https://librum.al/x", "//evil.com", "tel:1"]) {
      expect(opensInNewTab(h)).toBe(false);
    }
  });
});

describe("search text", () => {
  it("drops wildcards and needs 2 letters", () => {
    expect(cleanLinkSearchTerm("  pl%an_ * ")).toBe("pl an");
    expect(cleanLinkSearchTerm("a")).toBeNull();
    expect(cleanLinkSearchTerm("x".repeat(300))?.length).toBe(100);
  });
  it("is accent- and capital-blind", () => {
    expect(foldForSearch("Çela Dushkë")).toBe("cela dushke");
  });
  it("shortens the shown address", () => {
    expect(shortBlogHref("https://www.example.test/udhezues")).toBe("example.test/udhezues");
  });
});

describe("public article links (lk3 a)", () => {
  const show = (md: string) => renderToStaticMarkup(createElement(BlogMarkdown, { markdown: md }));
  it("opens an outside link in a new tab", () => {
    expect(show("[udhëzues](https://example.test/udhezues)")).toContain(
      '<a class="text-primary underline underline-offset-2" href="https://example.test/udhezues" target="_blank" rel="noopener noreferrer">udhëzues</a>',
    );
  });
  it("keeps a Librum link in the same tab", () => {
    const html = show("[libri](/libra/abc) [blog](https://librum.al/blog/x)");
    expect(html).toContain('<a class="text-primary underline underline-offset-2" href="/libra/abc">libri</a>');
    expect(html).toContain('href="https://librum.al/blog/x">blog</a>');
    expect(html).not.toContain("target=");
  });
  it("still drops a javascript: address", () => {
    expect(show("[x](javascript:alert(1))")).not.toContain("javascript");
  });
  it("opens an email link in the same tab (F2)", () => {
    expect(show("[shkruani](mailto:info@librum.al)")).toContain(
      '<a class="text-primary underline underline-offset-2" href="mailto:info@librum.al">shkruani</a>',
    );
  });
  it("shows a link outside the allowed list as plain words (F1)", () => {
    for (const md of ["[x](//evil.com/a)", "[x](tel:123)", "[x](javascript:alert(1))", "[x](ftp://example.com)"]) {
      const html = show(md);
      expect(html).not.toContain("<a");
      expect(html).toMatch(/>x<\/p>/);
    }
  });
});

describe("saved Markdown is unchanged", () => {
  it("a Librum link round-trips exactly", () => {
    const md = "Lexo [Planin e madh](/libra/0b9c) dhe [udhëzuesin](https://example.test/udhezues).";
    expect(blogDocToMarkdown(blogMarkdownToDoc(md))).toBe(md);
  });
  it("paste-to-link accepts only allowed addresses", () => {
    const starter = blogEditorExtensions().find((e) => e.name === "starterKit");
    const link = (starter?.options as { link: { shouldAutoLink: (u: string) => boolean; linkOnPaste: boolean } }).link;
    expect(link.linkOnPaste).toBe(true);
    expect(link.shouldAutoLink("https://example.com")).toBe(true);
    expect(link.shouldAutoLink("ftp://example.com")).toBe(false);
  });
  it("links in pasted HTML obey the same list (F1)", () => {
    const starter = blogEditorExtensions().find((e) => e.name === "starterKit");
    const link = (starter?.options as { link: { isAllowedUri: (u: string) => boolean } }).link;
    for (const ok of ["https://example.com", "/libra/1", "mailto:a@b.al"]) expect(link.isAllowedUri(ok)).toBe(true);
    for (const bad of ["//evil.com/x", "tel:123", "/\\evil.com", "javascript:alert(1)"]) expect(link.isAllowedUri(bad)).toBe(false);
  });
  it("an old article's link outside the list is kept as it was when opened and saved", () => {
    const md = "Thirr [këtu](tel:123).";
    expect(blogDocToMarkdown(blogMarkdownToDoc(md))).toBe(md);
  });
});
