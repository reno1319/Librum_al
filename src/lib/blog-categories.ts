import type { BlogCategory } from "./types";

// LIBRUM 2.0 BLOG-1C: the single source of truth for the four fixed V1
// blog categories -- both the admin category <select> and (in a later
// BLOG phase) the public /blog section headings read from this same
// list, so the two can never drift. Matches migration 047's own CHECK
// constraint exactly (`category in (...)`); no category admin CRUD
// exists in BLOG-1C, so this list is intentionally not persisted
// anywhere editable.
export const BLOG_CATEGORIES: readonly { value: BlogCategory; label: string }[] = [
  { value: "publishing", label: "Publishing" },
  { value: "writing", label: "Writing" },
  { value: "authors-books", label: "Authors & Books" },
  { value: "librum-guides", label: "Librum Guides" },
];

export const BLOG_CATEGORY_LABELS: Record<BlogCategory, string> = Object.fromEntries(
  BLOG_CATEGORIES.map((c) => [c.value, c.label]),
) as Record<BlogCategory, string>;

// LIBRUM 2.0 BLOG-1D: Albanian display labels for the PUBLIC blog only
// (/blog, /blog/[slug], article cards) -- the internal `category`
// values above (and BLOG_CATEGORY_LABELS, still used by the admin CMS)
// are deliberately unchanged, per the BLOG-1D brief's own explicit
// instruction to keep internal values stable. This is the stronger
// Albanian-first product choice for a public-facing, Albanian-first
// editorial resource -- the admin CMS itself stays in the platform's
// current language until LANG-1 (BLOG-1's own original design report
// already established this exact split), but a reader browsing the
// public Blog should never see English section labels on an
// Albanian-first page.
export const BLOG_CATEGORY_LABELS_SQ: Record<BlogCategory, string> = {
  publishing: "Botimi",
  writing: "Shkrimi",
  "authors-books": "Autorë & Libra",
  "librum-guides": "Udhëzues Librum",
};

export function isBlogCategory(value: string): value is BlogCategory {
  return BLOG_CATEGORIES.some((c) => c.value === value);
}
