// Blog picture size and position (Renato 2026-11-22, img1 a + img3 a).
// Saved inside the article's Markdown, at the end of the picture's
// address: "...kafeja.jpg#size=half&pos=left". The browser never sends
// the part after "#" to the server, so the address still loads the same
// file, and no database change is needed.
//   img1 a: three sizes, Full / Half / Small.
//   img3 a: Half and Small pictures can sit Left, Centre or Right; Left
//           and Right mean the text wraps beside the picture. Full is
//           always centred. On a phone every picture is full width.
// Anything else after "#" is ignored, so an old article (no "#") or a
// hand-typed value shows exactly as before: full width.

export type BlogImageSize = "full" | "half" | "small";
export type BlogImagePos = "left" | "centre" | "right";
export type BlogImageLayout = { size: BlogImageSize; pos: BlogImagePos };

export const DEFAULT_BLOG_IMAGE_LAYOUT: BlogImageLayout = { size: "full", pos: "centre" };

const SIZES: readonly BlogImageSize[] = ["full", "half", "small"];
const POSITIONS: readonly BlogImagePos[] = ["left", "centre", "right"];

// Splits an address into the file address and its layout.
export function splitBlogImageSrc(src: string): { url: string; layout: BlogImageLayout } {
  const hash = src.indexOf("#");
  if (hash === -1) return { url: src, layout: DEFAULT_BLOG_IMAGE_LAYOUT };
  const url = src.slice(0, hash);
  const parts = new Map<string, string>();
  for (const pair of src.slice(hash + 1).split("&")) {
    const eq = pair.indexOf("=");
    if (eq > 0 && !parts.has(pair.slice(0, eq))) parts.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return { url, layout: normaliseBlogImageLayout({ size: parts.get("size"), pos: parts.get("pos") }) };
}

export function normaliseBlogImageLayout(input: { size?: unknown; pos?: unknown }): BlogImageLayout {
  const size = SIZES.includes(input.size as BlogImageSize) ? (input.size as BlogImageSize) : "full";
  const pos = POSITIONS.includes(input.pos as BlogImagePos) ? (input.pos as BlogImagePos) : "centre";
  // Full is always centred (img3 a).
  return { size, pos: size === "full" ? "centre" : pos };
}

// The address to save. A Full picture saves no "#", so it reads exactly
// like an article written before this change.
export function joinBlogImageSrc(url: string, layout: BlogImageLayout): string {
  const base = url.split("#")[0];
  const clean = normaliseBlogImageLayout(layout);
  if (clean.size === "full") return base;
  return `${base}#size=${clean.size}&pos=${clean.pos}`;
}

// Classes for the public article and the editor. Below 640 px (phones)
// every picture is full width and nothing wraps.
export function blogImageLayoutClass(layout: BlogImageLayout): string {
  const { size, pos } = normaliseBlogImageLayout(layout);
  if (size === "full") return "mt-4 block clear-both";
  const width = size === "half" ? "sm:w-1/2" : "sm:w-1/3";
  const place =
    pos === "left"
      ? "sm:float-left sm:mr-6 sm:mb-3"
      : pos === "right"
        ? "sm:float-right sm:ml-6 sm:mb-3"
        : "sm:mx-auto sm:clear-both";
  return `mt-4 block w-full ${width} ${place}`;
}
