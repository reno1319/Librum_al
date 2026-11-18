import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { FOOTER_GROUPS, INSTAGRAM_HREF } from "./site-footer";

// LIBRUM 2.0 BLOG-1D: this repo has no component-rendering test
// infrastructure (see site-header.test.ts's own precedent) -- FOOTER_GROUPS
// is exported specifically so the footer's own content is directly
// testable, the same "extract and test the data" pattern used
// throughout this codebase.
describe("SiteFooter FOOTER_GROUPS", () => {
  it("includes a Blog link in Discover, alongside Bookstore, without removing anything", () => {
    const discoverHrefs = FOOTER_GROUPS.Zbuloni.map((l) => l.href);
    expect(discoverHrefs).toContain("/blog");
    expect(discoverHrefs).toContain("/librari");
    expect(discoverHrefs).toContain("/rreth-nesh");
  });

  it("does not add Blog to any unrelated group", () => {
    for (const [section, links] of Object.entries(FOOTER_GROUPS)) {
      if (section === "Zbuloni") continue;
      expect(links.some((l) => l.href === "/blog")).toBe(false);
    }
  });
});

describe("REFUND POLICY: footer Legal group", () => {
  it("lists Terms, Privacy, Refunds and Accessibility, in that order", () => {
    expect(FOOTER_GROUPS.Ligjore.map((l) => l.href)).toEqual(["/kushtet", "/privatesia", "/rimbursimet", "/aksesueshmeria"]);
    expect(FOOTER_GROUPS.Ligjore.find((l) => l.href === "/aksesueshmeria")?.label).toBe("Aksesueshmëria");
    expect(FOOTER_GROUPS.Ligjore.find((l) => l.href === "/rimbursimet")?.label).toBe("Rimbursimet");
  });
});

describe("SOCIAL (soc3): Instagram icon in the footer", () => {
  it("links to Librum's own Instagram page, with no tracking parameters", () => {
    expect(INSTAGRAM_HREF).toBe("https://www.instagram.com/librum.al");
  });

  it("is a plain link that opens in a new tab and has a name for screen readers", () => {
    const source = readFileSync(path.join(__dirname, "site-footer.tsx"), "utf8");
    expect(source).toMatch(/href=\{INSTAGRAM_HREF\}\s+target="_blank"\s+rel="noopener noreferrer"\s+aria-label="Librum në Instagram"/);
    expect(source).toContain("<IconInstagram");
  });
});
