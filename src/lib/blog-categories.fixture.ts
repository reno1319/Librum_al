import { toBlogCategories, type BlogCategoryInfo } from "./blog-categories";

// TEST ONLY: the six rows migration 20261119180000 inserts, for page
// tests that mock getBlogCategories() (blog-categories.test.ts checks
// these match the migration).
export const SEEDED_BLOG_CATEGORY_ROWS = [
  { value: "editorial", label: "Editorial", short_label: "Editorial", url_slug: "editorial", description: "Zëri editorial i Librum: opinione dhe analiza nga redaksia.", colour: "gold", cta: "browse", sort_order: 0 },
  { value: "zeja", label: "Zeja e Shkrimit", short_label: "Zeja e Shkrimit", url_slug: "zeja-e-shkrimit", description: "Teknika dhe udhëzues për prozën, poezinë, personazhet dhe dialogun.", colour: "green", cta: "publish", sort_order: 1 },
  { value: "tregu", label: "Tregu i Librit & Botimet", short_label: "Botimet", url_slug: "tregu-i-librit-dhe-botimet", description: "Botimi profesional, vetë-botimi, tregu i e-librave dhe marketingu letrar.", colour: "blue", cta: "publish", sort_order: 2 },
  { value: "kultura", label: "Kulturë & Njohuri", short_label: "Kulturë", url_slug: "kulture-dhe-njohuri", description: "Histori e letërsisë, gjuha shqipe, profile shkrimtarësh dhe qytete librash.", colour: "terracotta", cta: "browse", sort_order: 3 },
  { value: "reflektime", label: "Reflektime & Frymëzim", short_label: "Reflektime", url_slug: "reflektime-dhe-frymezim", description: "Intervista, ese mbi leximin dhe histori nga udhëtimi krijues.", colour: "purple", cta: "browse", sort_order: 4 },
  { value: "vleresime", label: "Vlerësimet & Rekomandimet", short_label: "Vlerësime", url_slug: "vleresimet-dhe-rekomandimet", description: "Vlerësime librash, lista leximi dhe sugjerime sipas zhanrit.", colour: "olive", cta: "browse", sort_order: 5 },
];

export const SEEDED_BLOG_CATEGORIES: BlogCategoryInfo[] = toBlogCategories(SEEDED_BLOG_CATEGORY_ROWS);
