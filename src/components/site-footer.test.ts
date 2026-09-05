import { describe, expect, it } from "vitest";
import { FOOTER_GROUPS } from "./site-footer";

// LIBRUM 2.0 BLOG-1D: this repo has no component-rendering test
// infrastructure (see site-header.test.ts's own precedent) -- FOOTER_GROUPS
// is exported specifically so the footer's own content is directly
// testable, the same "extract and test the data" pattern used
// throughout this codebase.
describe("SiteFooter FOOTER_GROUPS", () => {
  it("includes a Blog link in Discover, alongside Bookstore, without removing anything", () => {
    const discoverHrefs = FOOTER_GROUPS.Discover.map((l) => l.href);
    expect(discoverHrefs).toContain("/blog");
    expect(discoverHrefs).toContain("/bookstore");
    expect(discoverHrefs).toContain("/about");
  });

  it("does not add Blog to any unrelated group", () => {
    for (const [section, links] of Object.entries(FOOTER_GROUPS)) {
      if (section === "Discover") continue;
      expect(links.some((l) => l.href === "/blog")).toBe(false);
    }
  });
});
