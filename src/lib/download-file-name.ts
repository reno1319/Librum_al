import { slugify } from "@/lib/blog-slug";

// ALBANIAN-2: the name of a downloaded EPUB. The old rule dropped every
// letter outside a-z, so "Ëndrra e çmendur" became "-ndrra-e-mendur.epub".
// slugify() turns ë into e and ç into c (and strips other accents) first.
// A title with no usable letters at all still gets a name: "liber.epub".
export function downloadFileName(title: string): string {
  return `${slugify(title) || "liber"}.epub`;
}
