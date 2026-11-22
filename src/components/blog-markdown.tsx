import ReactMarkdown, { type Components } from "react-markdown";
import { blogImageLayoutClass, splitBlogImageSrc } from "@/lib/blog-image-layout";
import { isAllowedBlogHref, opensInNewTab } from "@/lib/blog-links";

// LIBRUM 2.0 BLOG-1C: the one shared Markdown render path for both the
// admin preview page and the editor's own live preview -- so staff
// never sees a preview that renders differently than the eventual
// public article (BLOG-1D reuses this exact component).
//
// Deliberately used WITHOUT the rehype-raw plugin: react-markdown's
// default pipeline never parses embedded HTML in the source Markdown
// as HTML at all -- it renders it as literal, escaped text. No
// dangerouslySetInnerHTML call exists anywhere in this component, and
// none is needed -- this is the actual safety property BLOG-1's own
// design report called for ("blog editors must NOT be able to store
// content that leads to unsafe script/event HTML on the public site"),
// satisfied by react-markdown's plain default behavior, not by adding a
// separate sanitizer on top of it.
//
// Per-element style overrides, not Tailwind's `prose` class -- the
// @tailwindcss/typography plugin isn't installed in this repo, and
// adding it just for this one preview surface would be a new
// dependency for a BLOG-1C admin-only page; plain component overrides
// reuse this app's own existing typographic tokens (font-serif
// headings, text-primary links, text-muted blockquotes) instead.
const COMPONENTS: Components = {
  h1: (props) => <h1 className="mt-6 font-serif text-2xl font-normal text-foreground" {...props} />,
  h2: (props) => <h2 className="mt-6 font-serif text-xl font-normal text-foreground" {...props} />,
  h3: (props) => <h3 className="mt-4 font-serif text-lg font-normal text-foreground" {...props} />,
  p: (props) => <p className="mt-4 leading-relaxed text-foreground/90" {...props} />,
  // lk3 a (Renato 2026-11-22): a link to another website opens in a new
  // tab (rel noopener noreferrer); a Librum or email link stays in the
  // same tab (audit LINK-r1 F2). A link outside the allowed list
  // (src/lib/blog-links.ts, e.g. "//other-site" or tel:) is shown as
  // plain words, not a link (F1).
  a: ({ node: _node, href, children, ...props }) => {
    const target = typeof href === "string" ? href : "";
    if (!isAllowedBlogHref(target)) return <>{children}</>;
    return opensInNewTab(target) ? (
      <a className="text-primary underline underline-offset-2" {...props} href={target} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <a className="text-primary underline underline-offset-2" {...props} href={target}>
        {children}
      </a>
    );
  },
  ul: (props) => <ul className="mt-4 list-disc space-y-1 pl-6" {...props} />,
  ol: (props) => <ol className="mt-4 list-decimal space-y-1 pl-6" {...props} />,
  blockquote: (props) => (
    <blockquote className="mt-4 border-l-4 border-primary pl-4 italic text-muted" {...props} />
  ),
  hr: (props) => <hr className="my-8 border-border" {...props} />,
  strong: (props) => <strong className="font-semibold" {...props} />,
  // e2 (Renato 2026-11-19): an image's Markdown title is its caption,
  // shown under the picture. Spans, not <figure>, because Markdown puts
  // an image inside a <p>. The whole picture is shown (no cropping).
  // img1/img3 (2026-11-22): size and position come from the "#..." end
  // of the address (src/lib/blog-image-layout.ts); the "#" part is
  // dropped from the address the page loads.
  img: ({ node: _node, title, alt, src, ...props }) => {
    const { url, layout } = splitBlogImageSrc(typeof src === "string" ? src : "");
    return (
      <span className={blogImageLayoutClass(layout)}>
        {/* eslint-disable-next-line @next/next/no-img-element -- Markdown source URLs are arbitrary strings, not statically known at build time, so next/image's own required width/height/loader contract doesn't apply here. */}
        <img className="block h-auto w-full rounded-card" {...props} src={url || undefined} alt={alt ?? ""} />
        {title ? <span className="mt-2 block text-sm text-muted">{title}</span> : null}
      </span>
    );
  },
};

// Audit EDITOR-r1 F1: only an article with a picture set to Left or
// Right (text wraps beside it) gets the wrap layout: the box keeps the
// floated picture inside it, and a list or quote sits beside the picture
// as one tidy block (its bullets and line never run under it). Every
// other article keeps exactly today's spacing (flow-root stops margins
// collapsing, which would add space above the first line and inside
// quotes and loose lists).
const WRAPPED_PICTURE = /#(?:[^\s)"#]*&)?pos=(?:left|right)(?:[&\s)"]|$)/;

export function hasWrappedPicture(markdown: string): boolean {
  return WRAPPED_PICTURE.test(markdown);
}

const WRAP_LAYOUT = "flow-root [&_ul]:flow-root [&_ol]:flow-root [&_blockquote]:flow-root";

export function BlogMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className={hasWrappedPicture(markdown) ? `${WRAP_LAYOUT} text-foreground` : "text-foreground"}>
      <ReactMarkdown components={COMPONENTS}>{markdown}</ReactMarkdown>
    </div>
  );
}
