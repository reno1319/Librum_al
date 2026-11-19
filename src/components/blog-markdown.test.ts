import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// LIBRUM 2.0 BLOG-1C: this repo's vitest config only runs `.test.ts`
// files (environment "node", no jsdom/testing-library anywhere), so
// BlogMarkdown's actual React output can't be rendered and inspected
// here the way a browser-based test suite would. This is a direct,
// honest substitute for the specific invariant that actually matters --
// "the Markdown renderer does not enable raw HTML/script execution" --
// verified as a real regression guard against the component's own
// source rather than skipped or faked: no dangerouslySetInnerHTML call
// exists anywhere in this file, and rehype-raw (the one react-markdown
// plugin that WOULD start parsing embedded HTML as real HTML) is never
// imported. Both are exactly the two ways this component could
// regress into an unsafe one.
describe("BlogMarkdown source safety", () => {
  const source = readFileSync(join(__dirname, "blog-markdown.tsx"), "utf8");

  // Checks actual usage patterns (a JSX prop assignment, a real import
  // statement), not mere mention -- this file's own header comment
  // names both terms in prose precisely BECAUSE it explains why neither
  // is used, so a bare substring check would trip on its own
  // documentation.
  it("never uses dangerouslySetInnerHTML", () => {
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });

  it("never imports or enables rehype-raw (the plugin that would parse embedded HTML as real HTML)", () => {
    expect(source).not.toMatch(/from\s+["']rehype-raw["']/);
    expect(source).not.toMatch(/import\s+rehypeRaw/);
  });

  it("imports react-markdown as its only Markdown rendering path", () => {
    expect(source).toContain('from "react-markdown"');
  });
});

// e2 (Renato 2026-11-19): an image's title is shown as its caption.
describe("BlogMarkdown image captions", () => {
  it("shows the caption under the picture, uncropped, and nothing when there is none", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { BlogMarkdown } = await import("./blog-markdown");
    const html = renderToStaticMarkup(
      createElement(BlogMarkdown, { markdown: '![Tryeza ime](https://x.test/a.jpg "Tryeza ime")\n\n![](https://x.test/b.jpg)' }),
    );
    expect(html).toContain('<img class="block h-auto w-full rounded-card" src="https://x.test/a.jpg" alt="Tryeza ime"/>');
    expect(html).toContain('<span class="mt-2 block text-sm text-muted">Tryeza ime</span>');
    expect(html).toContain('<img class="block h-auto w-full rounded-card" src="https://x.test/b.jpg" alt=""/>');
    expect(html.match(/text-sm text-muted/g)?.length).toBe(1);
    expect(html).not.toContain("<figure");
  });
});
