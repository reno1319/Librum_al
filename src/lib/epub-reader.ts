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
//     3% of the book; past that it counts. Then ~10% of the readable text,
//     but never more than SAMPLE_MAX_WORDS words (SC1: ~30 printed pages
//     at the page estimate's 250 words a page), so a long book does not
//     give away 80+ pages.
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
// SC1 (owner pick 11-10): 10%, but at most ~30 printed pages.
export const SAMPLE_MAX_WORDS = 7500;
// Owner pick 11-10 (card a): front matter is free for the word cap only
// up to ~5 printed pages; past that it counts toward the 30.
export const FRONT_MATTER_FREE_MAX_WORDS = 1250;

// Same word rule as the page estimate (countEpubWords): a run of
// non-space that holds a letter or a digit. Chunk text is still
// XML-escaped, so entities are removed first ("p&#235;r" is one word,
// a lone "&amp;" is none).
export function countWords(text: string): number {
  let words = 0;
  for (const token of text.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, "").split(/\s+/)) {
    if (/[\p{L}\p{N}]/u.test(token)) words += 1;
  }
  return words;
}
const MAX_SPINE_ITEMS = 1000;

// SC2: the cut is made between blocks, so one giant block (a book that is
// a single paragraph, list, table, quote, or text held together only by
// <br>) used to be sent whole. When the block would run more than
// GIANT_BLOCK_SLACK_WORDS (~1 printed page) past the limit, the sample is
// cut INSIDE it instead; any smaller overshoot keeps today's whole-block
// cut, so normal books are unchanged.
export const GIANT_BLOCK_SLACK_WORDS = 250;

const ENTITY_RE = /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi;
const isWord = (token: string) => /[\p{L}\p{N}]/u.test(token.replace(ENTITY_RE, ""));
// Our own (already cleaned) output only: every `<` in text is escaped.
const OWN_TAG_RE = /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/g;
const OWN_VOID = new Set(["br", "hr", "img"]);
const INLINE_TAGS = new Set(["span", "em", "strong", "i", "b", "u", "s", "small", "sup", "sub", "img"]);
// A sample may stop right after one of these closes (a list item, a
// paragraph inside a quote, a table row, ...).
const CUT_AFTER_CLOSE = new Set([
  "p", "li", "blockquote", "div", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "table", "ul", "ol",
  "figure", "figcaption", "aside", "caption",
]);
// A sentence end: . ! ? … (repeats allowed), then closing quotes or
// brackets, then a space or the end of the text run.
const SENTENCE_END_RE = /[.!?…]+[»”’"')\]]*(?=\s|$)/g;

// Picture indexes whose tokens are in a piece of cleaned html.
function imagesIn(html: string): number[] {
  return [...html.matchAll(new RegExp(`${IMAGE_TOKEN_PREFIX}(\\d+)${IMAGE_TOKEN_SUFFIX}`, "g"))].map((m) => Number(m[1]));
}

export type BlockTrim = {
  // html.slice(0, cut) + close is the sample's version of the chunk.
  cut: number;
  close: string;
  // The tags open at the cut, reopened after the full-mode marker.
  reopen: string;
  keptText: string;
};

// A tag reopened after the full-mode marker: the same tag and layout, but
// no id (a heading id is never doubled), no page break (the paragraph
// goes on, it does not start a new page), and a paragraph's second half
// gets no first-line indent.
function reopenTag(name: string, tag: string): string {
  const classes = (tag.match(/ class="([^"]*)"/)?.[1] ?? "").split(" ").filter((c) => c && c !== "lb-pb" && c !== "lb-break");
  if (name === "p" && !classes.includes("lb-ni")) classes.push("lb-ni");
  return classes.length ? `<${name} class="${classes.join(" ")}">` : `<${name}>`;
}

// Where to stop inside the region [start, end) of a chunk's html, given
// how many text characters and words the sample may still take. Null when
// the block does not overshoot by more than GIANT_BLOCK_SLACK_WORDS: the
// caller then keeps the whole block, as before.
export function trimInsideBlock(html: string, start: number, end: number, charBudget: number, wordBudget: number): BlockTrim | null {
  // Text runs of the region, in html and text coordinates.
  type Run = { at: number; text: string; textAt: number };
  type Tag = { at: number; endAt: number; name: string; closing: boolean };
  const runs: Run[] = [];
  const tags: Tag[] = [];
  let text = "";
  const re = new RegExp(OWN_TAG_RE.source, "g");
  re.lastIndex = start;
  let pos = start;
  // Text on both sides of a block tag or <br> is two words even with no
  // space between ("...fjale</li><li>Tjetra"): a newline is put in `text`
  // there (for counting only; it is never sent).
  let gap = false;
  const addRun = (from: number, to: number) => {
    if (gap && text) text += "\n";
    gap = false;
    runs.push({ at: from, text: html.slice(from, to), textAt: text.length });
    text += html.slice(from, to);
  };
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && m.index < end) {
    if (m.index > pos) addRun(pos, m.index);
    tags.push({ at: m.index, endAt: re.lastIndex, name: m[2], closing: m[1] === "/" });
    if (!INLINE_TAGS.has(m[2])) gap = true;
    pos = re.lastIndex;
  }
  if (pos < end) addRun(pos, end);

  // The text position where the limit is reached: the char budget, or the
  // end of the wordBudget-th word, whichever comes first.
  let limit = Math.max(1, charBudget);
  let seen = 0;
  for (const w of text.matchAll(/\S+/g)) {
    if (!isWord(w[0])) continue;
    seen += 1;
    if (seen >= Math.max(1, wordBudget)) {
      limit = Math.min(limit, w.index! + w[0].length);
      break;
    }
  }
  if (limit >= text.length) return null;
  if (countWords(text.slice(limit)) <= GIANT_BLOCK_SLACK_WORDS) return null;

  // html offset of a text position.
  const htmlAt = (textPos: number) => {
    for (let i = runs.length - 1; i >= 0; i--) if (runs[i].textAt <= textPos) return runs[i].at + (textPos - runs[i].textAt);
    return start;
  };
  const limitAt = htmlAt(limit);

  // First natural stop at or after the limit, within about a page: a
  // sentence end, a line break (poems keep whole lines), or the close of
  // an inner block. Else the end of the word the limit falls in.
  let best = Number.POSITIVE_INFINITY;
  for (const run of runs) {
    if (run.at + run.text.length < limitAt) continue;
    for (const s of run.text.matchAll(SENTENCE_END_RE)) {
      const at = run.at + s.index! + s[0].length;
      if (at >= limitAt) {
        best = Math.min(best, at);
        break;
      }
    }
    if (best < Number.POSITIVE_INFINITY) break;
  }
  for (const t of tags) {
    if (t.at < limitAt) continue;
    const at = t.name === "br" ? t.at : t.closing && CUT_AFTER_CLOSE.has(t.name) ? t.endAt : -1;
    if (at >= limitAt) {
      best = Math.min(best, at);
      break;
    }
  }
  const textOf = (cut: number) => {
    let out = "";
    for (const run of runs) if (run.at < cut) out += run.text.slice(0, cut - run.at);
    return out;
  };
  if (!Number.isFinite(best) || countWords(html.slice(limitAt, best).replace(/<[^>]*>/g, " ")) > GIANT_BLOCK_SLACK_WORDS) {
    const run = runs.find((r) => r.at <= limitAt && limitAt <= r.at + r.text.length)!;
    const space = run.text.slice(limitAt - run.at).search(/\s/);
    best = space === -1 ? run.at + run.text.length : limitAt + space;
  }

  // Tags still open at the cut (in the whole chunk, wrappers included).
  const open: { name: string; tag: string }[] = [];
  const all = new RegExp(OWN_TAG_RE.source, "g");
  while ((m = all.exec(html)) && m.index < best) {
    const name = m[2];
    if (OWN_VOID.has(name)) continue;
    if (m[1] === "/") {
      const i = open.map((o) => o.name).lastIndexOf(name);
      if (i !== -1) open.splice(i);
    } else open.push({ name, tag: m[0] });
  }
  return {
    cut: best,
    close: open.map((o) => `</${o.name}>`).reverse().join(""),
    reopen: open.map((o) => reopenTag(o.name, o.tag)).join(""),
    keptText: textOf(best),
  };
}

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
  const frontFree = Math.min(frontLength, Math.floor(total * FRONT_MATTER_FREE_FRACTION));
  const target = Math.max(1, Math.ceil(total * SAMPLE_FRACTION)) + frontFree;
  // The word cap gets the same free front matter, in words: the front
  // documents' words, at most 3% of the book's words and at most
  // FRONT_MATTER_FREE_MAX_WORDS.
  const words = (c: ReaderChunk) => countWords(c.text);
  const totalWords = docs.reduce((s, d) => s + d.chunks.reduce((t, c) => t + words(c), 0), 0);
  const frontWords = docs.filter((d) => d.front).reduce((s, d) => s + d.chunks.reduce((t, c) => t + words(c), 0), 0);
  const wordTarget =
    SAMPLE_MAX_WORDS + Math.min(frontWords, Math.floor(totalWords * FRONT_MATTER_FREE_FRACTION), FRONT_MATTER_FREE_MAX_WORDS);

  // The cut is made on "units": a whole chunk, or (SC1) one block of a
  // chunk that lists its inner blocks (a chapter wrapped in one
  // container). The first unit that reaches either target ends the sample.
  type Unit = { d: number; c: number; p: number; text: string; heading: boolean };
  const units: Unit[] = [];
  docs.forEach((doc, d) =>
    doc.chunks.forEach((chunk, c) => {
      if (chunk.parts) chunk.parts.forEach((part, p) => units.push({ d, c, p, text: part.text, heading: part.heading }));
      else units.push({ d, c, p: -1, text: chunk.text, heading: /^<h[1-6][\s>]/.test(chunk.html) });
    }),
  );
  let included = 0;
  let includedWords = 0;
  let cut = units.length - 1;
  for (let u = 0; u < units.length; u++) {
    included += units[u].text.length;
    includedWords += countWords(units[u].text);
    if (included >= target || includedWords >= wordTarget) {
      cut = u;
      break;
    }
  }
  // Never end the sample on a lone chapter title: step back past
  // trailing headings (they are the next chapter's, not this one's).
  while (units[cut].heading && cut > 0) cut -= 1;
  const { d: cutDoc, c: cutChunk } = units[cut];
  const cutPart = docs[cutDoc].chunks[cutChunk].parts;
  // A block inside a chunk, not its last one: the chunk is trimmed there.
  const trimAt = cutPart && units[cut].p < cutPart.length - 1 ? cutPart[units[cut].p] : null;
  // SC2: one giant block at the cut is cut inside (see trimInsideBlock).
  const cutHtml = docs[cutDoc].chunks[cutChunk].html;
  const regionStart = cutPart && units[cut].p > 0 ? cutPart[units[cut].p - 1].end : 0;
  const regionEnd = cutPart ? cutPart[units[cut].p].end : cutHtml.length;
  const before = units.slice(0, cut);
  const charsBefore = before.reduce((s, u) => s + u.text.length, 0);
  const wordsBefore = before.reduce((s, u) => s + countWords(u.text), 0);
  const giant = trimInsideBlock(cutHtml, regionStart, regionEnd, target - charsBefore, wordTarget - wordsBefore);
  if (giant) included = charsBefore + giant.keptText.length;
  const sampleTextShare = Math.min(100, Math.max(1, Math.round((Math.max(0, included - frontFree) / total) * 100)));

  const SAMPLE_END = '<div class="lb-sample-end" id="lb-sample-end"></div>';
  const sections: string[] = [];
  const usedImages = new Set<number>();
  for (let d = 0; d < docs.length; d++) {
    if (mode === "sample" && d > cutDoc) break;
    const parts: string[] = [];
    docs[d].chunks.forEach((chunk, c) => {
      if (mode === "sample" && d === cutDoc && c > cutChunk) return;
      const atCut = d === cutDoc && c === cutChunk;
      if (atCut && giant && mode === "sample") {
        const kept = chunk.html.slice(0, giant.cut);
        parts.push(kept + giant.close);
        for (const n of imagesIn(kept)) usedImages.add(n);
        return;
      }
      if (atCut && giant && mode === "full") {
        // The marker cannot sit inside a paragraph: close what is open,
        // mark, then reopen and go on.
        parts.push(chunk.html.slice(0, giant.cut) + giant.close + SAMPLE_END + giant.reopen + chunk.html.slice(giant.cut));
        chunk.images.forEach((n) => usedImages.add(n));
        return;
      }
      if (atCut && trimAt && mode === "sample") {
        // Everything before trimAt.end is byte-for-byte the chunk's own
        // html; then the wrappers still open there are closed.
        parts.push(chunk.html.slice(0, trimAt.end) + trimAt.close);
        for (const part of chunk.parts!.slice(0, units[cut].p + 1)) part.images.forEach((n) => usedImages.add(n));
        return;
      }
      if (atCut && trimAt && mode === "full") {
        parts.push(chunk.html.slice(0, trimAt.end) + SAMPLE_END + chunk.html.slice(trimAt.end));
        chunk.images.forEach((n) => usedImages.add(n));
        return;
      }
      parts.push(chunk.html);
      chunk.images.forEach((n) => usedImages.add(n));
      if (mode === "full" && atCut) parts.push(SAMPLE_END);
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
