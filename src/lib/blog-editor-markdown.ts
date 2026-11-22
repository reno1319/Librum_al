// The one-box blog editor (Renato 2026-11-22, ed3 a): what the editor
// understands, and how it turns an article to and from Markdown.
// Articles are still SAVED as Markdown, exactly as before, so the
// public pages, the 50,000-character limit, the outside-picture check
// and the "no raw HTML" safety of BlogMarkdown all stay the same. The
// editor only changes how staff write it.
//
// Shared by the editor (in the browser) and the tests (in Node), so the
// tests check the exact same rules the editor uses.

import { type AnyExtension, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import { MarkdownManager } from "@tiptap/markdown";
import { escapeAlt, escapeTitle } from "@/lib/markdown-format";
import { isAllowedBlogHref } from "@/lib/blog-links";
import { joinBlogImageSrc, splitBlogImageSrc, type BlogImagePos, type BlogImageSize } from "@/lib/blog-image-layout";

// Plain CommonMark, the same flavour BlogMarkdown shows. Without this,
// a bare web address typed as text would come back as a link, and
// ~~text~~ would be read as strikethrough, which the site does not show.
export const BLOG_MARKED_OPTIONS = { gfm: false } as const;

// A picture keeps its caption (Markdown title, also its alt text) and
// its size/position (img1/img3, saved after "#" in its address).
export const BlogImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      size: { default: "full" as BlogImageSize, rendered: false },
      pos: { default: "centre" as BlogImagePos, rendered: false },
    };
  },
  parseMarkdown: (token, helpers) => {
    const { url, layout } = splitBlogImageSrc(String(token.href ?? ""));
    return helpers.createNode("image", {
      src: url,
      title: token.title ?? null,
      alt: token.text ?? "",
      size: layout.size,
      pos: layout.pos,
    });
  },
  renderMarkdown: (node) => {
    const attrs = node.attrs ?? {};
    const src = joinBlogImageSrc(String(attrs.src ?? ""), { size: attrs.size, pos: attrs.pos });
    const caption = String(attrs.title ?? "").replace(/\s+/g, " ").trim();
    const alt = String(attrs.alt ?? "").replace(/\s+/g, " ").trim();
    return caption ? `![${escapeAlt(alt || caption)}](${src} "${escapeTitle(caption)}")` : `![${escapeAlt(alt)}](${src})`;
  },
});

export function blogEditorExtensions(image: AnyExtension = BlogImage): AnyExtension[] {
  return [
    StarterKit.configure({
      // The site shows neither underline nor strikethrough, so the
      // editor does not offer them (Ctrl+U would otherwise make text
      // that turns into "++text++" on the site).
      underline: false,
      strike: false,
      // Links (2026-11-22, lk1 c): pasting a web address onto selected
      // words links them; only addresses the link box accepts
      // (src/lib/blog-links.ts). A bare address typed as text stays text.
      // isAllowedUri: links in pasted HTML (copied from another page)
      // obey the same list; a refused link is kept as plain words
      // (audit LINK-r1 F1). Saved articles are read from Markdown, which
      // does not use this check, so opening an old article changes nothing.
      link: {
        openOnClick: false,
        autolink: false,
        linkOnPaste: true,
        shouldAutoLink: isAllowedBlogHref,
        isAllowedUri: (url: string) => isAllowedBlogHref(url),
      },
    }),
    image,
  ];
}

const manager = () => new MarkdownManager({ extensions: blogEditorExtensions(), markedOptions: BLOG_MARKED_OPTIONS });

export function blogMarkdownToDoc(markdown: string): JSONContent {
  return manager().parse(markdown);
}

export function blogDocToMarkdown(doc: JSONContent): string {
  return manager().serialize(doc);
}
