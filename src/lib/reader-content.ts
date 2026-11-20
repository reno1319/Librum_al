// PREVIEW-READER-1: the strict server cleaner for the page-turning reader
// (readers' sample and the author's full preview). Every EPUB goes
// through here before any of it reaches a browser.
//
// Output vocabulary, and nothing else:
//   - the tags in READER_TAGS, with NO attributes taken from the book;
//   - a `class` attribute only from READER_CLASSES (our own names, chosen
//     by this file from the book's CSS / inline style / known Librum
//     classes -- a book's class string itself never reaches the output);
//   - `id` attributes only of the form `lb-h-<n>` that this file makes up
//     for the Contents list;
//   - `<img>` only as an IMAGE PLACEHOLDER token that the caller later
//     swaps for a `data:` URI of a re-encoded copy of the book's own
//     picture (or for nothing). No URL from the book is ever emitted.
// Links are unwrapped to plain text, so nothing can point past the cut.
//
// Same tokenizer approach (and the same reasons) as epub-sample.ts:
// well-formed XHTML, a small stack, no parsing dependency.

import { cssRules, markupTokens } from "@/lib/markup-scan";

export const READER_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "div", "span",
  "em", "strong", "i", "b", "u", "s", "br", "hr", "ul", "ol", "li", "small", "sup", "sub",
  "figure", "figcaption", "aside",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);
// Subtree (text included) never reaches the output.
const DROP_ENTIRELY_TAGS = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button",
  "select", "textarea", "option", "video", "audio", "canvas", "svg", "math",
  "template", "noscript", "picture", "source", "link", "meta", "base",
  "head", "title", "frame", "frameset", "applet", "portal", "dialog",
]);

// Our own classes: the only class names the reader page's stylesheet
// knows, and the only ones that can ever be emitted.
export const READER_CLASSES = [
  "lb-c", "lb-r", "lb-l", "lb-j", "lb-i", "lb-b", "lb-sc", "lb-ni", "lb-in",
  "lb-pb", "lb-break", "lb-scene", "lb-verse", "lb-stanza", "lb-verse-in", "lb-gap",
  "lb-epi", "lb-episrc", "lb-note",
] as const;
export type ReaderClass = (typeof READER_CLASSES)[number];
const READER_CLASS_SET = new Set<string>(READER_CLASSES);

// Classes Librum's own Word converter writes (epub-generator.ts CSS).
const LIBRUM_CLASS_MAP: Record<string, ReaderClass[]> = {
  "scene-break": ["lb-scene"],
  center: ["lb-c"],
  right: ["lb-r"],
  verse: ["lb-verse"],
  "verse-stanza": ["lb-verse", "lb-stanza"],
  "verse-indent": ["lb-verse-in"],
  gap: ["lb-gap"],
  epigraph: ["lb-epi"],
  "epigraph-source": ["lb-episrc"],
  "librum-page-break": ["lb-break"],
  footnote: ["lb-note"],
  endnote: ["lb-note"],
};

export const IMAGE_TOKEN_PREFIX = "\u0000LBIMG:";
export const IMAGE_TOKEN_SUFFIX = "\u0000";
export const MAX_READER_DOCUMENT_CHARS = 2_000_000;
const MAX_CSS_CHARS = 400_000;
const MAX_CSS_RULES = 5_000;
// Most open containers the cleaner keeps at once. Real books stay well
// under 20 levels. Without a limit, every closing level re-copies all the
// html inside it, so a broken EPUB with thousands of never-closed <div>s
// took seconds (or minutes) on every reader open. Past the limit an
// opening tag is flattened: its text stays, in the deepest container,
// and its own matching close tag is skipped. Paragraphs and headings are
// the exception (one level only, never one inside another), so a broken
// book's text keeps its paragraphs and its Contents.
export const MAX_READER_DEPTH = 64;
const KEEP_PAST_DEPTH_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);

// ------------------------------------------------------------
// CSS: only a few layout facts are read, never passed through
// ------------------------------------------------------------

export function declarationClasses(decls: string): ReaderClass[] {
  const out = new Set<ReaderClass>();
  for (const part of decls.split(";")) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).replace(/!important/i, "").trim().toLowerCase();
    if (prop === "text-align") {
      if (value === "center") out.add("lb-c");
      else if (value === "right" || value === "end") out.add("lb-r");
      else if (value === "justify") out.add("lb-j");
      else if (value === "left" || value === "start") out.add("lb-l");
    } else if (prop === "font-style" && (value === "italic" || value === "oblique")) {
      out.add("lb-i");
    } else if (prop === "font-weight" && (value === "bold" || value === "bolder" || /^[6-9]00$/.test(value))) {
      out.add("lb-b");
    } else if ((prop === "font-variant" || prop === "font-variant-caps") && value.includes("small-caps")) {
      out.add("lb-sc");
    } else if (prop === "text-indent" && /^-?0(?:\.0+)?(?:[a-z%]*)$/.test(value)) {
      out.add("lb-ni");
    } else if ((prop === "margin-left" || prop === "padding-left") && /^(?:[1-9]\d*(?:\.\d+)?|0?\.\d*[1-9]\d*)(?:em|rem|%)$/.test(value)) {
      out.add("lb-in");
    } else if ((prop === "page-break-before" || prop === "break-before") && (value === "always" || value === "page" || value === "left" || value === "right")) {
      out.add("lb-pb");
    }
  }
  return [...out];
}

// `.cls`, `p.cls`, `div.a.b` -> classes; anything more complex is ignored.
export function parseCssClassRules(css: string, into: Map<string, Set<ReaderClass>> = new Map()) {
  const text = css.slice(0, MAX_CSS_CHARS).replace(/\/\*[\s\S]*?(?:\*\/|$)/g, "");
  let count = 0;
  for (const [selectors, body] of cssRules(text)) {
    if (count >= MAX_CSS_RULES) break;
    count += 1;
    const classes = declarationClasses(body);
    if (classes.length === 0) continue;
    for (const raw of selectors.split(",")) {
      const sel = raw.trim();
      const simple = sel.match(/^[a-z0-9]*((?:\.[\w-]+)+)$/i);
      if (!simple) continue;
      for (const name of simple[1].split(".").filter(Boolean)) {
        const key = name.toLowerCase();
        const set = into.get(key) ?? new Set<ReaderClass>();
        for (const c of classes) set.add(c);
        into.set(key, set);
      }
    }
  }
  return into;
}

// ------------------------------------------------------------
// Body sanitizer
// ------------------------------------------------------------

function readAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = attrs.match(re);
  return m ? (m[1] ?? m[2] ?? "") : null;
}

export function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Text is passed through as already-escaped XML text (entities stay as
// they are), but a stray `<` or `>` is ALWAYS escaped: a broken tag such
// as `<img src=x onerror=...` with no closing `>` before the next tag is
// not matched by the tokenizer and reaches here as "text" -- left raw, a
// browser would parse it as a live tag. NUL is removed so text can never
// forge an image token.
function cleanText(raw: string): string {
  return raw.replace(/\u0000/g, "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// SC1: the sample is cut between chunks, and a chapter wrapped in one
// big container (Calibre style: <div class="calibre"> around every
// paragraph) is ONE chunk. So a chunk made from a plain container (at the
// top of the body, or inside another one) also lists its inner block
// boundaries as `parts`. The chunk's html is exactly what it was before;
// a part only says where the html may be cut: html.slice(0, end) + close
// is the chunk up to and including that part, with the wrappers closed.
// Each part's text/images are those since the previous boundary.
export type ReaderPart = { end: number; close: string; text: string; images: number[]; heading: boolean };
export type ReaderChunk = { html: string; text: string; images: number[]; parts?: ReaderPart[] };

const SPLIT_TAGS = new Set(["div", "section", "article", "main", "header", "footer"]);
const BLOCK_TAGS = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "div", "ul", "ol", "li",
  "figure", "figcaption", "aside", "table", "hr",
  ...SPLIT_TAGS,
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
export type ReaderSanitizeContext = {
  classRules: Map<string, Set<ReaderClass>>;
  // Returns an image index for a picture of the book's own file, or null
  // (unsafe path, not found, the cover, or a non-picture).
  registerImage: (src: string) => number | null;
  // Running counter for heading ids, shared across documents.
  headingCounter: { next: number };
};

type Frame = {
  tag: string;
  allowed: boolean;
  dropped: boolean;
  classes: string;
  id: string;
  html: string[];
  text: string[];
  images: number[];
  // Only for a container whose blocks are tracked (SC1). All tracked
  // frames of one top-level chunk share one `parts` list, and each part
  // is written once, already in the chunk's own coordinates: `base` is
  // where this frame's inner html starts in the chunk, `length` its inner
  // length so far, `closeAll` the close tags of this frame and every
  // tracked frame around it, and `firstPart` where its own parts begin.
  parts: ReaderPart[] | null;
  length: number;
  base: number;
  closeAll: string;
  firstPart: number;
  // Tags flattened past MAX_READER_DEPTH while this frame was the deepest
  // one, by name, so their close tags are skipped. They go away with it.
  skipped: Map<string, number> | null;
};

function frame(tag: string, allowed: boolean, dropped: boolean, classes = "", id = ""): Frame {
  return { tag, allowed, dropped, classes, id, html: [], text: [], images: [], parts: null, length: 0, base: 0, closeAll: "", firstPart: 0, skipped: null };
}

// The cleaned wrapper of a closed frame, as its open and close strings.
function wrapper(f: Frame): [string, string] {
  if (f.allowed) {
    const classAttr = f.classes ? ` class="${f.classes}"` : "";
    const idAttr = f.id ? ` id="${f.id}"` : "";
    return [`<${f.tag}${idAttr}${classAttr}>`, `</${f.tag}>`];
  }
  // An unwrapped container (section, a, ...) that carried layout:
  // keep the layout on a neutral wrapper.
  if (f.classes) return [`<div class="${f.classes}">`, "</div>"];
  return ["", ""];
}

function classesFor(tag: string, attrs: string, ctx: ReaderSanitizeContext): string {
  const out = new Set<ReaderClass>();
  const cls = readAttr(attrs, "class");
  if (cls) {
    for (const name of cls.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12)) {
      for (const c of LIBRUM_CLASS_MAP[name] ?? []) out.add(c);
      for (const c of ctx.classRules.get(name) ?? []) out.add(c);
    }
  }
  const style = readAttr(attrs, "style");
  if (style) for (const c of declarationClasses(style)) out.add(c);
  const epubType = (readAttr(attrs, "epub:type") ?? "").toLowerCase();
  if (tag === "aside" && /\b(?:footnote|endnote|note|rearnote)\b/.test(epubType)) out.add("lb-note");
  if (/\bpagebreak\b/.test(epubType)) return "";
  return [...out].filter((c) => READER_CLASS_SET.has(c)).join(" ");
}

export function sanitizeReaderBody(bodyHtml: string, ctx: ReaderSanitizeContext): ReaderChunk[] {
  const root = frame("#root", false, false);
  const stack: Frame[] = [root];
  const chunks: ReaderChunk[] = [];
  // How many dropped frames are open, so this check does not scan the stack.
  let dropDepth = 0;
  const inDrop = () => dropDepth > 0;
  // Loose text/images in tracked frames since the last part boundary.
  let pendingText: string[] = [];
  let pendingImages: number[] = [];

  function flushRoot() {
    if (root.html.length === 0) return;
    const text = root.text.join("");
    if (text.trim() || root.images.length > 0) {
      chunks.push({ html: `<p>${root.html.join("")}</p>`, text, images: root.images });
    }
    root.html = [];
    root.text = [];
    root.images = [];
  }

  // Every write into a frame's inner html goes through here, so a
  // tracked frame always knows its inner length and what came since its
  // last boundary.
  function put(f: Frame, html: string, text: string, images: number[], loose = true) {
    f.html.push(html);
    f.text.push(text);
    f.images.push(...images);
    if (f.parts) {
      f.length += html.length;
      if (loose) {
        pendingText.push(text);
        pendingImages.push(...images);
      }
    }
  }

  // A boundary at the current end of tracked frame `f`: the part takes
  // its own text/images plus everything loose since the last boundary.
  function addPart(f: Frame, text: string, images: number[], heading: boolean) {
    const before = pendingText.join("");
    f.parts!.push({
      end: f.base + f.length,
      close: f.closeAll,
      text: before + text,
      images: [...pendingImages, ...images],
      heading: heading && !before.trim(),
    });
    pendingText = [];
    pendingImages = [];
  }

  function appendText(raw: string) {
    if (!raw || inDrop()) return;
    const t = cleanText(raw);
    put(stack[stack.length - 1], t, t, []);
  }

  // `childParts`: a closed tracked child's parts (already in the shared
  // list, in chunk coordinates).
  function emit(rendered: string, text: string, images: number[], block = false, heading = false, childParts: ReaderPart[] | null = null) {
    const parent = stack[stack.length - 1];
    if (parent === root) {
      flushRoot();
      if (text.trim() || images.length > 0) {
        chunks.push(childParts && childParts.length > 1 ? { html: rendered, text, images, parts: childParts } : { html: rendered, text, images });
      }
      return;
    }
    if (!parent.parts || !block) {
      put(parent, rendered, text, images);
      return;
    }
    put(parent, rendered, text, images, false);
    if (!childParts) addPart(parent, text, images, heading);
  }

  // Closes every frame above stack[idx - 1], innermost first.
  function closeFrom(idx: number) {
    while (stack.length > idx) {
      const done = stack.pop()!;
      if (done.dropped) {
        dropDepth -= 1;
        continue;
      }
      const inner = done.html.join("");
      const [open, close] = wrapper(done);
      const rendered = `${open}${inner}${close}`;
      if (done.parts) {
        // Loose content after the last block is the last part.
        const own = done.parts.length - done.firstPart;
        if (pendingText.join("").trim() || pendingImages.length > 0 || own === 0) addPart(done, "", [], false);
        pendingText = [];
        pendingImages = [];
      }
      emit(rendered, done.text.join(""), done.images, BLOCK_TAGS.has(done.tag), HEADING_TAGS.has(done.tag), done.parts);
    }
  }

  const capped = bodyHtml.length > MAX_READER_DOCUMENT_CHARS ? bodyHtml.slice(0, MAX_READER_DOCUMENT_CHARS) : bodyHtml;
  let last = 0;
  for (const m of markupTokens(capped)) {
    appendText(capped.slice(last, m.index));
    last = m.end;
    const { closeName, openName, attrs = "", selfMark } = m;

    if (closeName) {
      const name = closeName.toLowerCase();
      const top = stack[stack.length - 1];
      const flattened = top.skipped?.get(name) ?? 0;
      if (flattened > 0) {
        top.skipped!.set(name, flattened - 1);
        continue;
      }
      const idx = stack.map((f) => f.tag).lastIndexOf(name);
      if (idx <= 0) continue;
      closeFrom(idx);
      continue;
    }

    if (!openName) continue;
    const name = openName.toLowerCase();
    const local = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
    const selfClosing = selfMark === "/" || VOID_TAGS.has(name);

    const dropTag = DROP_ENTIRELY_TAGS.has(name) || DROP_ENTIRELY_TAGS.has(local);
    // Past the depth limit, flatten. A tag that must drop its contents is
    // still pushed when nothing around it drops already, so its text can
    // never leak; inside it everything is dropped anyway. A paragraph or
    // heading is still pushed when it is not inside another one. So the
    // stack grows past the limit by at most two frames.
    const top = stack[stack.length - 1];
    const keepBlock = KEEP_PAST_DEPTH_TAGS.has(name) && !KEEP_PAST_DEPTH_TAGS.has(top.tag);
    if (!selfClosing && stack.length > MAX_READER_DEPTH && (inDrop() || (!dropTag && !keepBlock))) {
      top.skipped ??= new Map();
      top.skipped.set(name, (top.skipped.get(name) ?? 0) + 1);
      continue;
    }

    if (inDrop() || dropTag) {
      if (!selfClosing) {
        stack.push(frame(name, false, true));
        dropDepth += 1;
      }
      continue;
    }

    if (name === "img") {
      const src = readAttr(attrs, "src");
      const index = src ? ctx.registerImage(src) : null;
      if (index !== null) {
        const alt = readAttr(attrs, "alt") ?? "";
        const f = stack[stack.length - 1];
        put(f, `<img alt="${escapeAttr(decodeBasicEntities(alt).replace(/\u0000/g, "").slice(0, 300))}" src="${IMAGE_TOKEN_PREFIX}${index}${IMAGE_TOKEN_SUFFIX}">`, "", [index]);
      }
      continue;
    }
    if (name === "br" || name === "hr") {
      put(stack[stack.length - 1], `<${name}>`, "", []);
      continue;
    }
    if (selfClosing) continue;

    const allowed = READER_TAGS.has(name);
    const classes = classesFor(name, attrs, ctx);
    let id = "";
    if (allowed && (name === "h1" || name === "h2")) {
      id = `lb-h-${ctx.headingCounter.next}`;
      ctx.headingCounter.next += 1;
    }
    const parent = stack[stack.length - 1];
    const f = frame(name, allowed, false, classes, id);
    if (SPLIT_TAGS.has(name) && (parent === root || parent.parts !== null)) {
      const [open, close] = wrapper(f);
      const outer = parent === root ? null : parent;
      f.parts = outer ? outer.parts : [];
      f.firstPart = f.parts!.length;
      f.base = (outer ? outer.base + outer.length : 0) + open.length;
      f.closeAll = close + (outer ? outer.closeAll : "");
    }
    stack.push(f);
  }
  appendText(capped.slice(last));
  // Tags still open at the end of the document (e.g. `<p>hello` with no
  // `</p>`) are closed here, innermost first, by the same rules as a real
  // close tag, so their text is kept; dropped frames stay dropped.
  closeFrom(1);
  flushRoot();
  return chunks;
}

// Headings with ids, as plain text for the Contents list.
export function readHeadings(html: string): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const re = /<h[12] id="(lb-h-\d+)"[^>]*>([\s\S]*?)<\/h[12]>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const label = decodeBasicEntities(m[2].replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
    if (label) out.push({ id: m[1], label: label.slice(0, 120) });
  }
  return out;
}

function decodeBasicEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
  return String.fromCodePoint(code);
}
