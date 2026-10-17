import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { chartDayLabels } from "@/lib/chart-day-labels";
import { CoverPlaceholder } from "@/components/cover-placeholder";
import HowItWorksPage from "./how-it-works/page";

// FIX1: source-level guards for the small fixes that have no page-level
// render harness, in the same style as upload-wizard.wiring.test.ts.
const root = path.join(__dirname, "..", "..", "..");
const read = (relative: string) => readFileSync(path.join(root, relative), "utf8");

describe("FIX1 X2: every header Sign up preselects Author", () => {
  it("desktop header, phone menu and How it works link to /signup?role=author", () => {
    for (const file of [
      "src/components/site-header.tsx",
      "src/components/mobile-nav.tsx",
      "src/app/(public)/how-it-works/page.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain('href="/signup?role=author"');
      expect(source).not.toContain('href="/signup"');
    }
  });
});

describe("FIX1 X3: How it works numbers each step once", () => {
  it("the titles carry no typed number and the list numbers them", () => {
    const html = renderToStaticMarkup(HowItWorksPage());
    expect(html).toContain("list-decimal");
    expect(html).toContain(">Sign up as an author</h2>");
    expect(html).not.toMatch(/>\d\. /);
  });
});

describe("FIX1 X12: header on one row, a quiet Log out, one word for it", () => {
  const header = read("src/components/site-header.tsx");

  it("does not wrap from 1024px up", () => {
    expect(header).toContain("lg:flex-nowrap");
  });

  it("draws Log out as a text link, not the outline button", () => {
    const logout = header.match(/<button type="submit" className=\{(\w+)\}>\s*Log out/);
    expect(logout?.[1]).toBe("QUIET_LINK_ON_DARK_CLASSES");
  });

  it('says "Log out" everywhere, never "Sign out"', () => {
    for (const file of [
      "src/app/(public)/account/page.tsx",
      "src/app/admin/admin-shell.tsx",
      "src/app/admin/admin-mobile-nav.tsx",
      "src/app/admin/login/page.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain("Log out");
      expect(source).not.toMatch(/>\s*Sign out\s*</);
    }
  });
});

describe("FIX1 X13: chart labels carry the month", () => {
  it("the first bar names its month", () => {
    expect(chartDayLabels([new Date(2026, 9, 12)])[0]).toEqual({ day: "12", month: "Oct" });
  });
});

describe("FIX1 X14: the cover placeholder", () => {
  it("is a green cover with the title in serif and the author under it, hidden from screen readers", () => {
    const html = renderToStaticMarkup(
      CoverPlaceholder({ title: "Era e Veriut", authorName: "Arta", className: "w-16" }),
    );
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("bg-primary");
    expect(html).toContain("text-primary-foreground");
    expect(html.indexOf("Era e Veriut")).toBeLessThan(html.indexOf("Arta"));
    expect(html).toMatch(/font-serif[^"]*">Era e Veriut/);
  });

  it("leaves out an empty title or author rather than drawing a blank line", () => {
    const html = renderToStaticMarkup(CoverPlaceholder({ title: " ", authorName: null }));
    expect(html).not.toContain("<span");
  });

  it("replaces every no-cover block on reader and dashboard surfaces", () => {
    for (const file of [
      "src/components/book-card.tsx",
      "src/components/library-book-card.tsx",
      "src/components/author-book-row.tsx",
      "src/app/(public)/books/[id]/page.tsx",
      "src/app/(public)/bookstore/page.tsx",
      "src/app/(public)/authors/[id]/page.tsx",
      "src/app/(public)/dashboard/books/new/upload-wizard.tsx",
    ]) {
      const source = read(file);
      expect(source).toContain("<CoverPlaceholder");
      expect(source).not.toMatch(/aspect-\[2\/3\] w-full rounded[^"]*bg-border/);
    }
  });
});

describe("FIX1 X15: one heading style", () => {
  it("no serif heading on a public or dashboard page is bold", () => {
    const files = [
      "src/components/ui/page-header.tsx",
      "src/app/(public)/how-it-works/page.tsx",
      "src/app/(public)/dashboard/books/[id]/edit/page.tsx",
      "src/app/(public)/dashboard/balance/page.tsx",
      "src/app/(public)/terms/page.tsx",
      "src/app/(public)/account/page.tsx",
    ];
    for (const file of files) {
      const headings = read(file).match(/<h[1-4]\b[^>]*font-serif[^>]*>/g) ?? [];
      for (const tag of headings) {
        expect(tag).not.toMatch(/font-(semibold|bold|medium)/);
      }
    }
  });
});
