import JSZip from "jszip";
import { posix } from "node:path";
import sharp from "sharp";
import { preflightZipEntries } from "@/lib/zip-preflight";
import { EPUB_ZIP_PREFLIGHT_LIMITS } from "@/lib/epub-validation";
import { resolveArchivePath } from "@/lib/epub-archive-paths";
import {
  IMAGE_TOKEN_PREFIX,
  IMAGE_TOKEN_SUFFIX,
  parseCssClassRules,
  readHeadings,
  sanitizeReaderBody,
  type ReaderChunk,
  type ReaderClass,
} from "@/lib/reader-content";

// PREVIEW-READER-1: builds what the page-turning reader shows, on the
// server, from the book's own EPUB:
//   - "sample": the readers' sample. Front matter (everything before the
//     book's own "start of the text" landmark) is shown and is free up to
//     3% of the book; past that it counts. Then ~10% of the readable text.
//     Nothing past the cut is ever put in the response: no text, no
//     picture, no chapter title.
//   - "full": the author's own whole book, with a marker where the
//     readers' sample ends.
// Pictures are re-encoded by sharp and sent inline as data: URIs, so the
// reader never gets a URL to the book's file and the reader frame can
// block every network load.

export type ReaderMode = "sample" | "full";
export type ReaderTocEntry = { id: string; label: string };
export type ReaderContent =
  | {
      available: true;
      html: string;
      toc: ReaderTocEntry[];
      // Share of the book's readable text the readers' sample covers.
      approximatePercent: number;
    }
  | { available: false };

export const SAMPLE_FRACTION = 0.1;
export const FRONT_MATTER_FREE_FRACTION = 0.03;
const MAX_SPINE_ITEMS = 1000;

// Picture budgets: count, and total inline bytes after re-encoding.
const IMAGE_LIMITS: Record<ReaderMode, { count: number; bytes: number }> = {
  sample: { count: 40, bytes: 6 * 1024 * 1024 },
  full: { count: 400, bytes: 40 * 1024 * 1024 },
};
const MAX_SOURCE_PIXELS = 40_000_000;
const RASTER_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const CONTENT_TYPES = new Set(["application/xhtml+xml", "text/html"]);

type ManifestItem = { id: string; href: string; path: string | null; mediaType: string; properties: string };

function attr(attrs: string, name: string): string | undefined {
  return attrs.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2];
}

function stripFragment(href: string): string {
  const i = href.indexOf("#");
  const bare = i === -1 ? href : href.slice(0, i);
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

async function readText(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path);
  if (!f) return null;
  try {
    return await f.async("string");
  } catch {
    return null;
  }
}

export function isRasterImage(bytes: Buffer): boolean {
  if (bytes.length < 12) return false;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const gif = bytes.subarray(0, 4).toString("latin1") === "GIF8";
  const webp = bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  return jpeg || png || gif || webp;
}

async function encodeImage(bytes: Buffer): Promise<string | null> {
  if (!isRasterImage(bytes)) return null;
  try {
    const out = await sharp(bytes, { limitInputPixels: MAX_SOURCE_PIXELS, animated: false })
      .rotate()
      .resize({ width: 1200, height: 1600, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
    return `data:image/webp;base64,${out.toString("base64")}`;
  } catch {
    return null;
  }
}

type Doc = { path: string; chunks: ReaderChunk[]; front: boolean };

export async function buildReaderContent(bytes: Buffer, mode: ReaderMode): Promise<ReaderContent> {
  if (!preflightZipEntries(bytes, EPUB_ZIP_PREFLIGHT_LIMITS).ok) return { available: false };
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    return { available: false };
  }

  const container = await readText(zip, "META-INF/container.xml");
  const rootfile = container?.match(/<rootfile\b[^>]*\bfull-path\s*=\s*(["'])(.*?)\1/i)?.[2];
  if (!rootfile) return { available: false };
  const opfRes = resolveArchivePath("", rootfile.trim().replace(/^\/+/, ""));
  if (!opfRes.safe) return { available: false };
  const opf = await readText(zip, opfRes.path);
  if (!opf) return { available: false };
  const opfDir = posix.dirname(opfRes.path);

  // Manifest.
  const manifest = new Map<string, ManifestItem>();
  const byPath = new Map<string, ManifestItem>();
  const manifestXml = opf.match(/<manifest\b[^>]*>([\s\S]*?)<\/manifest>/i)?.[1] ?? "";
  for (const m of manifestXml.matchAll(/<item\b([^>]*?)\/?>/gi)) {
    const id = attr(m[1], "id");
    const href = attr(m[1], "href");
    if (!id || !href) continue;
    const res = resolveArchivePath(opfDir, stripFragment(href));
    const item: ManifestItem = {
      id,
      href,
      path: res.safe ? res.path : null,
      mediaType: (attr(m[1], "media-type") ?? "").toLowerCase(),
      properties: (attr(m[1], "properties") ?? "").toLowerCase(),
    };
    manifest.set(id, item);
    if (item.path) byPath.set(item.path, item);
    if (manifest.size > MAX_SPINE_ITEMS * 4) break;
  }
  if (manifest.size === 0) return { available: false };

  // The cover picture is shown by the reader itself as page 1.
  const coverPaths = new Set<string>();
  const coverMetaId = opf.match(/<meta\b[^>]*\bname\s*=\s*["']cover["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
  for (const item of manifest.values()) {
    if (!item.path) continue;
    if (/\bcover-image\b/.test(item.properties) || item.id === coverMetaId) coverPaths.add(item.path);
  }

  // Spine.
  const spineXml = opf.match(/<spine\b[^>]*>([\s\S]*?)<\/spine>/i)?.[1] ?? "";
  const spine: ManifestItem[] = [];
  const seen = new Set<string>();
  for (const m of spineXml.matchAll(/<itemref\b([^>]*?)\/?>/gi)) {
    if ((attr(m[1], "linear") ?? "").toLowerCase() === "no") continue;
    const item = manifest.get(attr(m[1], "idref") ?? "");
    if (!item?.path || /\bnav\b/.test(item.properties)) continue;
    if (item.mediaType && !CONTENT_TYPES.has(item.mediaType)) continue;
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    spine.push(item);
    if (spine.length >= MAX_SPINE_ITEMS) break;
  }
  if (spine.length === 0) return { available: false };

  // Where the text itself starts: EPUB 3 landmarks "bodymatter", else the
  // EPUB 2 guide "text". Without either, nothing is front matter.
  let bodyStart: string | null = null;
  const nav = [...manifest.values()].find((i) => /\bnav\b/.test(i.properties) && i.path);
  if (nav?.path) {
    const navXml = (await readText(zip, nav.path)) ?? "";
    const landmarks = navXml.match(/<nav\b[^>]*epub:type\s*=\s*["'][^"']*\blandmarks\b[^"']*["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? "";
    for (const a of landmarks.matchAll(/<a\b([^>]*)>/gi)) {
      if (/\bbodymatter\b/i.test(attr(a[1], "epub:type") ?? "")) {
        const res = resolveArchivePath(posix.dirname(nav.path), stripFragment(attr(a[1], "href") ?? ""));
        if (res.safe) bodyStart = res.path;
        break;
      }
    }
  }
  if (!bodyStart) {
    const guide = opf.match(/<guide\b[^>]*>([\s\S]*?)<\/guide>/i)?.[1] ?? "";
    for (const r of guide.matchAll(/<reference\b([^>]*?)\/?>/gi)) {
      const type = (attr(r[1], "type") ?? "").toLowerCase();
      if (type === "text" || type === "bodymatter") {
        const res = resolveArchivePath(opfDir, stripFragment(attr(r[1], "href") ?? ""));
        if (res.safe) bodyStart = res.path;
        break;
      }
    }
  }
  const bodyIndex = bodyStart ? spine.findIndex((i) => i.path === bodyStart) : -1;

  // Read every document once, with the book's CSS turned into our classes.
  const classRules = new Map<string, Set<ReaderClass>>();
  const cssRead = new Set<string>();
  const imagePaths: string[] = [];
  const imageIndex = new Map<string, number>();
  const headingCounter = { next: 1 };
  const docs: Doc[] = [];

  for (let i = 0; i < spine.length; i++) {
    const path = spine[i].path!;
    const xml = await readText(zip, path);
    if (xml === null) continue;
    const docDir = posix.dirname(path);
    const head = xml.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? "";
    for (const link of head.matchAll(/<link\b([^>]*?)\/?>/gi)) {
      if (!/stylesheet/i.test(attr(link[1], "rel") ?? "")) continue;
      const res = resolveArchivePath(docDir, stripFragment(attr(link[1], "href") ?? ""));
      if (!res.safe || cssRead.has(res.path)) continue;
      cssRead.add(res.path);
      const css = await readText(zip, res.path);
      if (css) parseCssClassRules(css, classRules);
    }
    for (const style of head.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) parseCssClassRules(style[1], classRules);

    const body = xml.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? xml;
    const chunks = sanitizeReaderBody(body, {
      classRules,
      headingCounter,
      registerImage(src) {
        if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return null; // remote / data / any scheme
        const res = resolveArchivePath(docDir, stripFragment(src));
        if (!res.safe || coverPaths.has(res.path)) return null;
        const item = byPath.get(res.path);
        if (!item || !RASTER_TYPES.has(item.mediaType)) return null;
        const known = imageIndex.get(res.path);
        if (known !== undefined) return known;
        imagePaths.push(res.path);
        imageIndex.set(res.path, imagePaths.length - 1);
        return imagePaths.length - 1;
      },
    });
    if (chunks.length > 0) docs.push({ path, chunks, front: bodyIndex > 0 && i < bodyIndex });
  }

  const length = (c: ReaderChunk) => c.text.length;
  const total = docs.reduce((s, d) => s + d.chunks.reduce((t, c) => t + length(c), 0), 0);
  if (total === 0) return { available: false };
  const frontLength = docs.filter((d) => d.front).reduce((s, d) => s + d.chunks.reduce((t, c) => t + length(c), 0), 0);
  const target =
    Math.max(1, Math.ceil(total * SAMPLE_FRACTION)) + Math.min(frontLength, Math.floor(total * FRONT_MATTER_FREE_FRACTION));

  // The cut: the first chunk that reaches the target ends the sample.
  let included = 0;
  let cutDoc = docs.length - 1;
  let cutChunk = docs[cutDoc].chunks.length - 1;
  outer: for (let d = 0; d < docs.length; d++) {
    for (let c = 0; c < docs[d].chunks.length; c++) {
      included += length(docs[d].chunks[c]);
      if (included >= target) {
        cutDoc = d;
        cutChunk = c;
        break outer;
      }
    }
  }
  // Never end the sample on a lone chapter title: step back past
  // trailing headings (they are the next chapter's, not this one's).
  while (/^<h[1-6][\s>]/.test(docs[cutDoc].chunks[cutChunk].html) && (cutDoc > 0 || cutChunk > 0)) {
    if (cutChunk > 0) cutChunk -= 1;
    else {
      cutDoc -= 1;
      cutChunk = docs[cutDoc].chunks.length - 1;
    }
  }
  const sampleTextShare = Math.min(100, Math.max(1, Math.round((Math.max(0, included - Math.min(frontLength, Math.floor(total * FRONT_MATTER_FREE_FRACTION))) / total) * 100)));

  const sections: string[] = [];
  const usedImages = new Set<number>();
  for (let d = 0; d < docs.length; d++) {
    if (mode === "sample" && d > cutDoc) break;
    const parts: string[] = [];
    docs[d].chunks.forEach((chunk, c) => {
      if (mode === "sample" && d === cutDoc && c > cutChunk) return;
      parts.push(chunk.html);
      chunk.images.forEach((n) => usedImages.add(n));
      if (mode === "full" && d === cutDoc && c === cutChunk) {
        parts.push('<div class="lb-sample-end" id="lb-sample-end"></div>');
      }
    });
    sections.push(`<section class="lb-sec">${parts.join("")}</section>`);
  }
  let html = sections.join("");

  // Pictures: only those inside what is being sent, within budget.
  const limits = IMAGE_LIMITS[mode];
  const encoded = new Map<number, string>();
  let spent = 0;
  for (const n of [...usedImages].sort((a, b) => a - b)) {
    if (encoded.size >= limits.count) break;
    const entry = zip.file(imagePaths[n]);
    if (!entry) continue;
    let raw: Buffer;
    try {
      raw = await entry.async("nodebuffer");
    } catch {
      continue;
    }
    const uri = await encodeImage(raw);
    if (!uri || spent + uri.length > limits.bytes) continue;
    spent += uri.length;
    encoded.set(n, uri);
  }
  const tokenImg = new RegExp(`<img alt="([^"]*)" src="${IMAGE_TOKEN_PREFIX}(\\d+)${IMAGE_TOKEN_SUFFIX}">`, "g");
  html = html.replace(tokenImg, (_, alt: string, n: string) => {
    const uri = encoded.get(Number(n));
    return uri ? `<img alt="${alt}" src="${uri}">` : "";
  });
  // Belt and braces: no token may survive in any form.
  html = html.split(IMAGE_TOKEN_PREFIX).join("").split("\u0000").join("");

  return { available: true, html, toc: readHeadings(html), approximatePercent: sampleTextShare };
}
