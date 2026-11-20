import { BLOG_CATEGORY_COLOURS, type BlogCategoryColour } from "./blog-category-colours";

// Blog categories. Patch B (Renato 2026-11-19): the list lives in the
// blog_categories table (migration 20261119180000_blog_categories_manage.sql)
// and owner/admin staff add, rename, reorder and delete categories at
// /admin/blog/categories. Server pages load it once per request with
// getBlogCategories() (blog-categories-server.ts) and pass it to the
// pure helpers below, so the admin <select>, the /blog bands, the
// category buttons, the category pages and the post page all read the
// same rows.
//
// value      the stored, ASCII database value (never shown). Fixed.
// label      the full Albanian name: headings, card labels, admin.
// shortLabel the name on the category buttons.
// urlSlug    the /blog/kategoria/<urlSlug> path segment. Fixed (b4 a).
// colour     one of 8 tested pairs (b3 a); "gold" is Editorial's own.
// cta        the bottom button on its posts and category page (b7 a).
//
// Editorial (bs1): the "editorial" row is a SECTION, not a category.
// Posts are filed under one of the others and Editorial is a tick on
// top (blog_posts.is_editorial). It is always first, can be renamed but
// not deleted, and keeps gold (b2 b).
export type BlogCategoryInfo = {
  value: string;
  label: string;
  shortLabel: string;
  urlSlug: string;
  description: string;
  colour: BlogCategoryColour;
  tint: string;
  ink: string;
  cta: "publish" | "browse";
};

export type BlogCategoryRow = {
  value: string;
  label: string;
  short_label: string;
  url_slug: string;
  description: string;
  colour: string;
  cta: string;
  sort_order: number;
};

export const BLOG_CATEGORY_COLUMNS = "value, label, short_label, url_slug, description, colour, cta, sort_order";

export const EDITORIAL_VALUE = "editorial";

// Rows as read from the table -> the display list: Editorial first,
// then sort_order (ties by value, so the order is always stable). A row
// with an unknown colour or cta (cannot happen under the table's
// CHECKs) falls back to green / browse rather than breaking the page.
export function toBlogCategories(rows: readonly BlogCategoryRow[]): BlogCategoryInfo[] {
  return [...rows]
    .sort(
      (a, b) =>
        Number(b.value === EDITORIAL_VALUE) - Number(a.value === EDITORIAL_VALUE) ||
        a.sort_order - b.sort_order ||
        (a.value < b.value ? -1 : a.value > b.value ? 1 : 0),
    )
    .map((r) => {
      const colour = (r.colour in BLOG_CATEGORY_COLOURS ? r.colour : "green") as BlogCategoryColour;
      const pair = BLOG_CATEGORY_COLOURS[colour];
      return {
        value: r.value,
        label: r.label,
        shortLabel: r.short_label,
        urlSlug: r.url_slug,
        description: r.description,
        colour,
        tint: pair.tint,
        ink: pair.ink,
        cta: r.cta === "publish" ? "publish" : "browse",
      };
    });
}

// The categories a post can be filed under (admin select, validation).
export function blogPostCategories(list: readonly BlogCategoryInfo[]): BlogCategoryInfo[] {
  return list.filter((c) => c.value !== EDITORIAL_VALUE);
}

export function isBlogCategory(list: readonly BlogCategoryInfo[], value: string): boolean {
  return value !== EDITORIAL_VALUE && list.some((c) => c.value === value);
}

// Does a post belong in this section? Editorial = the tick; every other
// section = the post's own category (bs1 a: an Editorial post is in both).
export function isPostInSection(
  post: { category: string; is_editorial: boolean },
  section: string,
): boolean {
  return section === EDITORIAL_VALUE ? post.is_editorial === true : post.category === section;
}

// Undefined for a value not in the list: callers render no label
// rather than crash.
export function getBlogCategory(list: readonly BlogCategoryInfo[], value: string): BlogCategoryInfo | undefined {
  return list.find((c) => c.value === value);
}

export function getBlogCategoryByUrlSlug(
  list: readonly BlogCategoryInfo[],
  urlSlug: string,
): BlogCategoryInfo | undefined {
  return list.find((c) => c.urlSlug === urlSlug);
}

export function blogCategoryHref(category: Pick<BlogCategoryInfo, "urlSlug">): string {
  return `/blog/kategoria/${category.urlSlug}`;
}

// Bottom button (blog6). /blog itself always uses "publish".
export const BLOG_CTA = {
  publish: { prompt: "Gati ta botoni librin tuaj?", label: "Publikoni librin tuaj", href: "/signup?role=author" },
  browse: { prompt: "Po kërkoni librin tuaj të radhës?", label: "Shfletoni librarinë", href: "/librari" },
} as const;

// blog8: an empty category keeps its band and page with this one line.
export const BLOG_CATEGORY_EMPTY_LINE = "Artikujt e parë po vijnë së shpejti.";

// ---- Admin form rules (mirrored by the SQL RPCs) ----
export const CATEGORY_LABEL_MAX = 60;
export const CATEGORY_SHORT_LABEL_MAX = 24;
export const CATEGORY_DESCRIPTION_MAX = 200;
export const CATEGORY_URL_SLUG_MAX = 60;
export const CATEGORY_URL_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// b4 a: the address is suggested from the name and fixed once the
// category exists. "&" -> "dhe", accents dropped (ë -> e, ç -> c),
// everything else to a-z0-9 joined by single "-".
export function suggestCategoryAddress(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, " dhe ")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CATEGORY_URL_SLUG_MAX)
    .replace(/-+$/g, "");
}
