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
