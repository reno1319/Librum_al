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

export function isBlogCategory(value: string): value is BlogCategory {
  return BLOG_CATEGORIES.some((c) => c.value === value);
}
