import { describe, expect, it } from "vitest";
import {
  BLOG_CATEGORIES,
  BLOG_CATEGORY_LABELS,
  blogCategoryHref,
  getBlogCategory,
  getBlogCategoryByUrlSlug,
  isBlogCategory,
  isPostInSection,
  BLOG_POST_CATEGORIES,
} from "./blog-categories";
import { readFileSync } from "fs";
import path from "path";

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("blog categories", () => {
  it("exactly the six approved categories, Editorial first, in the approved order and names", () => {
    expect(BLOG_CATEGORIES.map((c) => [c.value, c.label, c.shortLabel])).toEqual([
      ["editorial", "Editorial", "Editorial"],
      ["zeja", "Zeja e Shkrimit", "Zeja e Shkrimit"],
      ["tregu", "Tregu i Librit & Botimet", "Botimet"],
      ["kultura", "Kulturë & Njohuri", "Kulturë"],
      ["reflektime", "Reflektime & Frymëzim", "Reflektime"],
      ["vleresime", "Vlerësimet & Rekomandimet", "Vlerësime"],
    ]);
    expect(BLOG_CATEGORY_LABELS.tregu).toBe("Tregu i Librit & Botimet");
  });

  it("the six section values are ASCII (Editorial + the five stored categories)", () => {
    const migration = BLOG_CATEGORIES.map((c) => `'${c.value}'`).join(", ");
    expect(migration).toBe("'editorial', 'zeja', 'tregu', 'kultura', 'reflektime', 'vleresime'");
  });

  it("bs1: a post can be filed under five categories only; Editorial is a section (the tick), never a stored category", () => {
    expect(BLOG_POST_CATEGORIES.map((c) => c.value)).toEqual(["zeja", "tregu", "kultura", "reflektime", "vleresime"]);
    expect(isBlogCategory("editorial")).toBe(false);
    expect(getBlogCategory("editorial")?.label).toBe("Editorial");
    const migration = readFileSync(
      path.join(__dirname, "../../supabase/migrations/20261117230000_blog_editorial_keywords.sql"),
      "utf8",
    );
    const list = BLOG_POST_CATEGORIES.map((c) => `'${c.value}'`).join(", ");
    expect(migration).toContain(`check (category in (${list}))`);
  });

  it("bs1 a: isPostInSection -- Editorial follows the tick, every other section the post's own category", () => {
    const ticked = { category: "tregu", is_editorial: true };
    const plain = { category: "tregu", is_editorial: false };
    expect(isPostInSection(ticked, "editorial")).toBe(true);
    expect(isPostInSection(ticked, "tregu")).toBe(true);
    expect(isPostInSection(ticked, "zeja")).toBe(false);
    expect(isPostInSection(plain, "editorial")).toBe(false);
    expect(isPostInSection(plain, "tregu")).toBe(true);
  });

  it("the four old values are no longer categories", () => {
    for (const old of ["publishing", "writing", "authors-books", "librum-guides"]) {
      expect(isBlogCategory(old)).toBe(false);
      expect(getBlogCategory(old)).toBeUndefined();
    }
  });

  it("url slugs are unique, lowercase ASCII, and round-trip", () => {
    const slugs = BLOG_CATEGORIES.map((c) => c.urlSlug);
    expect(new Set(slugs).size).toBe(6);
    for (const c of BLOG_CATEGORIES) {
      expect(c.urlSlug).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(getBlogCategoryByUrlSlug(c.urlSlug)).toBe(c);
      expect(blogCategoryHref(c)).toBe(`/blog/kategoria/${c.urlSlug}`);
    }
    expect(getBlogCategoryByUrlSlug("zeja")).toBeUndefined();
  });

  it("bottom button: publish for Zeja and Tregu only (blog6)", () => {
    expect(BLOG_CATEGORIES.filter((c) => c.cta === "publish").map((c) => c.value)).toEqual(["zeja", "tregu"]);
  });

  it("every colour reads well: ink on its tint, on the cream page, and white on ink all at least 6.4:1", () => {
    for (const c of BLOG_CATEGORIES) {
      expect(contrast(c.ink, c.tint)).toBeGreaterThanOrEqual(6.4);
      expect(contrast(c.ink, "#f7f3ea")).toBeGreaterThanOrEqual(6.4);
      expect(contrast(c.ink, "#ffffff")).toBeGreaterThanOrEqual(6.4);
      // muted text (#4c5751) on the band tint
      expect(contrast("#4c5751", c.tint)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
