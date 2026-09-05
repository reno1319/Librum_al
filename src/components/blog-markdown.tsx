import ReactMarkdown, { type Components } from "react-markdown";

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
  h1: (props) => <h1 className="mt-6 font-serif text-2xl font-semibold text-foreground" {...props} />,
  h2: (props) => <h2 className="mt-6 font-serif text-xl font-semibold text-foreground" {...props} />,
  h3: (props) => <h3 className="mt-4 font-serif text-lg font-semibold text-foreground" {...props} />,
  p: (props) => <p className="mt-4 leading-relaxed text-foreground/90" {...props} />,
  a: (props) => <a className="text-primary underline underline-offset-2" {...props} />,
  ul: (props) => <ul className="mt-4 list-disc space-y-1 pl-6" {...props} />,
  ol: (props) => <ol className="mt-4 list-decimal space-y-1 pl-6" {...props} />,
  blockquote: (props) => (
    <blockquote className="mt-4 border-l-4 border-primary pl-4 italic text-muted" {...props} />
  ),
  hr: (props) => <hr className="my-8 border-border" {...props} />,
  strong: (props) => <strong className="font-semibold" {...props} />,
  // eslint-disable-next-line @next/next/no-img-element -- Markdown source URLs are arbitrary strings, not statically known at build time, so next/image's own required width/height/loader contract doesn't apply here.
  img: (props) => <img className="mt-4 aspect-[3/2] w-full rounded-lg object-cover" {...props} alt={props.alt ?? ""} />,
};

export function BlogMarkdown({ markdown }: { markdown: string }) {
  return (
    <div className="text-foreground">
      <ReactMarkdown components={COMPONENTS}>{markdown}</ReactMarkdown>
    </div>
  );
}
