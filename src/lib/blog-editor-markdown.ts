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
import { BulletList, OrderedList } from "@tiptap/extension-list";
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

// Spaced lists (ls1, 2026-11-22): a list written with a blank line
// between its items ("loose") shows a gap between them on the site; one
// without ("tight") does not. The editor remembers which kind each list
// was and saves it the same way, so opening and saving an article keeps
// every list looking exactly as it did. A list made in the editor is
// tight, as before. The editor itself looks the same for both kinds.
type ListToken = { loose?: unknown; items?: { raw?: unknown }[] };

// Bullet lists come from the standard Markdown reader, which already
// says whether a list is loose. Numbered lists come from Tiptap's own
// reader, which does not, so it is worked out from the item text the
// same way CommonMark does: a blank line between two items, or between
// two parts of one item, makes the list loose.
export function isLooseListToken(token: ListToken): boolean {
  if (typeof token.loose === "boolean") return token.loose;
  const items = Array.isArray(token.items) ? token.items : [];
  return items.some((item, i) => {
    const raw = typeof item.raw === "string" ? item.raw : "";
    if (/\n[ \t]*\n[ \t]*\S/.test(raw)) return true;
    return i < items.length - 1 && /\n[ \t]*$/.test(raw);
  });
}

function withLooseAttr<T extends { attrs?: Record<string, unknown> }>(node: T | T[], token: ListToken): T | T[] {
  if (Array.isArray(node) || !isLooseListToken(token)) return node;
  return { ...node, attrs: { ...node.attrs, loose: true } };
}

const looseAttribute = {
  loose: { default: false, rendered: false, parseHTML: () => false },
};

const renderList = (node: JSONContent, h: { renderChildren: (nodes: JSONContent[], separator?: string) => string }) =>
  node.content ? h.renderChildren(node.content, node.attrs?.loose ? "\n\n" : "\n") : "";

export const BlogBulletList = BulletList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...looseAttribute };
  },
  parseMarkdown(token, helpers) {
    return withLooseAttr(this.parent!(token, helpers), token);
  },
  renderMarkdown: (node, h) => renderList(node, h),
});

export const BlogOrderedList = OrderedList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...looseAttribute };
  },
  parseMarkdown(token, helpers) {
    return withLooseAttr(this.parent!(token, helpers), token);
  },
  renderMarkdown: (node, h) => renderList(node, h),
});

export function blogEditorExtensions(image: AnyExtension = BlogImage): AnyExtension[] {
  return [
    StarterKit.configure({
      // The site shows neither underline nor strikethrough, so the
      // editor does not offer them (Ctrl+U would otherwise make text
      // that turns into "++text++" on the site).
      underline: false,
      strike: false,
      // Replaced below by the versions that remember list spacing.
      bulletList: false,
      orderedList: false,
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
    BlogBulletList,
    BlogOrderedList,
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
