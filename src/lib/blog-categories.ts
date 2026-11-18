import type { BlogCategory, BlogSection } from "./types";

// Blog categories (Renato 2026-11-17): the single source of truth for
// the six fixed categories. The admin <select>, the public /blog
// bands, the category buttons, the /blog/kategoria/[slug] pages and the
// post page all read this one list, so they can never drift. Matches
// the blog_posts category CHECK and create/update_blog_post() in
// migration 20261117180000_blog_categories.sql exactly; no category
// admin CRUD exists, so this list is intentionally not persisted
// anywhere editable.
//
// value      the stored, ASCII-only database value (never shown).
// label      the full Albanian name: section headings, card labels,
//            admin select and list.
// shortLabel the name on the category buttons (blog9: short names).
// urlSlug    the /blog/kategoria/<urlSlug> path segment.
// tint/ink   the category's own colour (soft band background / darker
//            text colour); every ink passes 6.4:1 on its tint and on
//            the cream page background.
// cta        the bottom button on its posts and category page (blog6):
//            "publish" for the two author categories, "browse" for the
//            reader ones.
//
// Editorial (bs1, Renato 2026-11-17): the first entry is a SECTION, not
// a category. Posts are filed under one of the other five and Editorial
// is a tick on top (blog_posts.is_editorial). BLOG_CATEGORIES is the six
// sections (buttons, /blog bands, category pages); BLOG_POST_CATEGORIES
// is the five a post can be filed under (admin select, validation).
export type BlogCategoryInfo = {
  value: BlogSection;
  label: string;
  shortLabel: string;
  urlSlug: string;
  description: string;
  tint: string;
  ink: string;
  cta: "publish" | "browse";
};

export const BLOG_CATEGORIES: readonly BlogCategoryInfo[] = [
  {
    value: "editorial",
    label: "Editorial",
    shortLabel: "Editorial",
    urlSlug: "editorial",
    description: "Zëri editorial i Librum: opinione dhe analiza nga redaksia.",
    tint: "#fbf3dc",
    ink: "#6b5512",
    cta: "browse",
  },
  {
    value: "zeja",
    label: "Zeja e Shkrimit",
    shortLabel: "Zeja e Shkrimit",
    urlSlug: "zeja-e-shkrimit",
    description: "Teknika dhe udhëzues për prozën, poezinë, personazhet dhe dialogun.",
    tint: "#eef3ef",
    ink: "#24513f",
    cta: "publish",
  },
  {
    value: "tregu",
    label: "Tregu i Librit & Botimet",
    shortLabel: "Botimet",
    urlSlug: "tregu-i-librit-dhe-botimet",
    description: "Botimi profesional, vetë-botimi, tregu i e-librave dhe marketingu letrar.",
    tint: "#e9eff4",
    ink: "#24496a",
    cta: "publish",
  },
  {
    value: "kultura",
    label: "Kulturë & Njohuri",
    shortLabel: "Kulturë",
    urlSlug: "kulture-dhe-njohuri",
    description: "Histori e letërsisë, gjuha shqipe, profile shkrimtarësh dhe qytete librash.",
    tint: "#f6ebe5",
    ink: "#7a3626",
    cta: "browse",
  },
  {
    value: "reflektime",
    label: "Reflektime & Frymëzim",
    shortLabel: "Reflektime",
    urlSlug: "reflektime-dhe-frymezim",
    description: "Intervista, ese mbi leximin dhe histori nga udhëtimi krijues.",
    tint: "#efecf6",
    ink: "#4d3f78",
    cta: "browse",
  },
  {
    value: "vleresime",
    label: "Vlerësimet & Rekomandimet",
    shortLabel: "Vlerësime",
    urlSlug: "vleresimet-dhe-rekomandimet",
    description: "Vlerësime librash, lista leximi dhe sugjerime sipas zhanrit.",
    tint: "#f1efe0",
    ink: "#565414",
    cta: "browse",
  },
];

export const BLOG_POST_CATEGORIES: readonly (BlogCategoryInfo & { value: BlogCategory })[] =
  BLOG_CATEGORIES.filter((c): c is BlogCategoryInfo & { value: BlogCategory } => c.value !== "editorial");

export const BLOG_CATEGORY_LABELS: Record<BlogSection, string> = Object.fromEntries(
  BLOG_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<BlogSection, string>;

// True only for the five post categories: "editorial" is a tick, never
// a stored category.
export function isBlogCategory(value: string): value is BlogCategory {
  return BLOG_POST_CATEGORIES.some((c) => c.value === value);
}

// Does a post belong in this section? Editorial = the tick; every other
// section = the post's own category (bs1 a: an Editorial post is in both).
export function isPostInSection(
  post: { category: string; is_editorial: boolean },
  section: BlogSection,
): boolean {
  return section === "editorial" ? post.is_editorial === true : post.category === section;
}

// Undefined for a value outside the six (e.g. a row not yet moved by
// the migration): callers render no label rather than crash.
export function getBlogCategory(value: string): BlogCategoryInfo | undefined {
  return BLOG_CATEGORIES.find((c) => c.value === value);
}

export function getBlogCategoryByUrlSlug(urlSlug: string): BlogCategoryInfo | undefined {
  return BLOG_CATEGORIES.find((c) => c.urlSlug === urlSlug);
}

export function blogCategoryHref(category: BlogCategoryInfo): string {
  return `/blog/kategoria/${category.urlSlug}`;
}

// Bottom button (blog6). /blog itself always uses "publish".
export const BLOG_CTA = {
  publish: { prompt: "Gati ta botoni librin tuaj?", label: "Publikoni librin tuaj", href: "/signup?role=author" },
  browse: { prompt: "Po kërkoni librin tuaj të radhës?", label: "Shfletoni librarinë", href: "/librari" },
} as const;

// blog8: an empty category keeps its band and page with this one line.
export const BLOG_CATEGORY_EMPTY_LINE = "Artikujt e parë po vijnë së shpejti.";
