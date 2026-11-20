import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import {
  blogCategoryHref,
  blogPostCategories,
  getBlogCategory,
  getBlogCategoryByUrlSlug,
  isBlogCategory,
  isPostInSection,
  suggestCategoryAddress,
  toBlogCategories,
  CATEGORY_URL_SLUG_PATTERN,
  type BlogCategoryRow,
} from "./blog-categories";
import { BLOG_CATEGORY_COLOURS, BLOG_CATEGORY_PICKABLE_COLOURS } from "./blog-category-colours";
import { SEEDED_BLOG_CATEGORY_ROWS } from "./blog-categories.fixture";

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

const MIGRATION = readFileSync(
  path.join(__dirname, "../../supabase/migrations/20261119180000_blog_categories_manage.sql"),
  "utf8",
);

// The six rows the migration inserts, read from its own INSERT.
function seededRows(): BlogCategoryRow[] {
  const block = MIGRATION.slice(
    MIGRATION.indexOf("insert into public.blog_categories"),
    MIGRATION.indexOf("alter table public.blog_categories enable"),
  );
  return [...block.matchAll(/\('([^']*)', '([^']*)', '([^']*)', '([^']*)',\s*'([^']*)', '([^']*)', '([^']*)', (\d+)\)/g)].map(
    (m) => ({
      value: m[1],
      label: m[2],
      short_label: m[3],
      url_slug: m[4],
      description: m[5],
      colour: m[6],
      cta: m[7],
      sort_order: Number(m[8]),
    }),
  );
}

describe("blog categories: the migration's six rows match the old fixed list", () => {
  const list = toBlogCategories(seededRows());

  it("same values, names, short names, addresses, colours and buttons as before patch B", () => {
    expect(list.map((c) => [c.value, c.label, c.shortLabel, c.urlSlug, c.tint, c.ink, c.cta])).toEqual([
      ["editorial", "Editorial", "Editorial", "editorial", "#fbf3dc", "#6b5512", "browse"],
      ["zeja", "Zeja e Shkrimit", "Zeja e Shkrimit", "zeja-e-shkrimit", "#eef3ef", "#24513f", "publish"],
      ["tregu", "Tregu i Librit & Botimet", "Botimet", "tregu-i-librit-dhe-botimet", "#e9eff4", "#24496a", "publish"],
      ["kultura", "Kulturë & Njohuri", "Kulturë", "kulture-dhe-njohuri", "#f6ebe5", "#7a3626", "browse"],
      ["reflektime", "Reflektime & Frymëzim", "Reflektime", "reflektime-dhe-frymezim", "#efecf6", "#4d3f78", "browse"],
      ["vleresime", "Vlerësimet & Rekomandimet", "Vlerësime", "vleresimet-dhe-rekomandimet", "#f1efe0", "#565414", "browse"],
    ]);
  });

  it("the test fixture is exactly the migration's rows", () => {
    expect(SEEDED_BLOG_CATEGORY_ROWS).toEqual(seededRows());
  });

  it("the migration's colour CHECK lists exactly the palette", () => {
    const keys = Object.keys(BLOG_CATEGORY_COLOURS).map((k) => `'${k}'`).join(", ");
    expect(MIGRATION).toContain(`check (colour in (${keys}))`);
    const pickable = BLOG_CATEGORY_PICKABLE_COLOURS.map((k) => `'${k}'`).join(", ");
    expect(MIGRATION).toContain(`p_colour not in (${pickable})`);
  });
});

describe("blog categories: helpers", () => {
  const rows: BlogCategoryRow[] = [
    { value: "zeja", label: "Zeja", short_label: "Zeja", url_slug: "zeja-e-shkrimit", description: "d", colour: "green", cta: "publish", sort_order: 2 },
    { value: "perkthime", label: "Përkthime", short_label: "Përkthime", url_slug: "perkthime", description: "d", colour: "teal", cta: "publish", sort_order: 1 },
    { value: "editorial", label: "Editorial", short_label: "Editorial", url_slug: "editorial", description: "d", colour: "gold", cta: "browse", sort_order: 9 },
    { value: "abc", label: "Abc", short_label: "Abc", url_slug: "abc", description: "d", colour: "nope", cta: "nope", sort_order: 2 },
  ];
  const list = toBlogCategories(rows);

  it("Editorial first, then sort_order, ties by value; unknown colour/button fall back safely", () => {
    expect(list.map((c) => c.value)).toEqual(["editorial", "perkthime", "abc", "zeja"]);
    const abc = getBlogCategory(list, "abc")!;
    expect([abc.colour, abc.cta]).toEqual(["green", "browse"]);
  });

  it("bs1: Editorial is a section, never a post's category", () => {
    expect(blogPostCategories(list).map((c) => c.value)).toEqual(["perkthime", "abc", "zeja"]);
    expect(isBlogCategory(list, "editorial")).toBe(false);
    expect(isBlogCategory(list, "perkthime")).toBe(true);
    expect(isBlogCategory(list, "writing")).toBe(false);
    expect(getBlogCategory(list, "editorial")?.label).toBe("Editorial");
  });

  it("bs1 a: isPostInSection -- Editorial follows the tick, every other section the post's own category", () => {
    const ticked = { category: "tregu", is_editorial: true };
    const plain = { category: "tregu", is_editorial: false };
    expect(isPostInSection(ticked, "editorial")).toBe(true);
    expect(isPostInSection(ticked, "tregu")).toBe(true);
    expect(isPostInSection(ticked, "zeja")).toBe(false);
    expect(isPostInSection(plain, "editorial")).toBe(false);
  });

  it("addresses round-trip", () => {
    for (const c of list) {
      expect(getBlogCategoryByUrlSlug(list, c.urlSlug)).toBe(c);
      expect(blogCategoryHref(c)).toBe(`/blog/kategoria/${c.urlSlug}`);
    }
    expect(getBlogCategoryByUrlSlug(list, "zeja")).toBeUndefined();
  });

  it("b4 a: the suggested address from a name", () => {
    expect(suggestCategoryAddress("Përkthime")).toBe("perkthime");
    expect(suggestCategoryAddress("Kulturë & Njohuri")).toBe("kulture-dhe-njohuri");
    expect(suggestCategoryAddress("  Çështje   letrare!! ")).toBe("ceshtje-letrare");
    expect(suggestCategoryAddress("Libra 2027")).toBe("libra-2027");
    expect(suggestCategoryAddress("!!!")).toBe("");
    const long = suggestCategoryAddress("a ".repeat(40));
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toMatch(CATEGORY_URL_SLUG_PATTERN);
  });
});

describe("blog categories: the 8 colours (b3 a) and Editorial gold", () => {
  it("every ink reads well: on its tint, on the cream page, and white on ink, at least 6.4:1", () => {
    for (const c of Object.values(BLOG_CATEGORY_COLOURS)) {
      expect(contrast(c.ink, c.tint)).toBeGreaterThanOrEqual(6.4);
      expect(contrast(c.ink, "#f7f3ea")).toBeGreaterThanOrEqual(6.4);
      expect(contrast(c.ink, "#ffffff")).toBeGreaterThanOrEqual(6.4);
      expect(contrast("#4c5751", c.tint)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("8 to pick from; gold is Editorial's only", () => {
    expect(BLOG_CATEGORY_PICKABLE_COLOURS).toEqual(["green", "blue", "terracotta", "purple", "olive", "teal", "rose", "slate"]);
  });
});
