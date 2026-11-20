// Blog categories patch B (b3 a, 2026-11-19): a category's colour is
// one of these 8 tested pairs (tint = band background, ink = heading,
// dot and filled button). Every ink is at least 6.4:1 on its own tint
// and on the page cream #f7f3ea. "gold" is Editorial's own and is not
// offered for other categories.
export const BLOG_CATEGORY_COLOURS = {
  green: { name: "Green", tint: "#eef3ef", ink: "#24513f" },
  blue: { name: "Blue", tint: "#e9eff4", ink: "#24496a" },
  terracotta: { name: "Terracotta", tint: "#f6ebe5", ink: "#7a3626" },
  purple: { name: "Purple", tint: "#efecf6", ink: "#4d3f78" },
  olive: { name: "Olive", tint: "#f1efe0", ink: "#565414" },
  teal: { name: "Teal", tint: "#e6f2f1", ink: "#1f5552" },
  rose: { name: "Rose", tint: "#f7e9ee", ink: "#7a2e4b" },
  slate: { name: "Slate", tint: "#ebedf0", ink: "#3b4654" },
  gold: { name: "Gold", tint: "#fbf3dc", ink: "#6b5512" },
} as const;

export type BlogCategoryColour = keyof typeof BLOG_CATEGORY_COLOURS;
export const BLOG_CATEGORY_PICKABLE_COLOURS = (Object.keys(BLOG_CATEGORY_COLOURS) as BlogCategoryColour[]).filter(
  (c) => c !== "gold",
);
