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
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  let count = 0;
  while ((m = ruleRe.exec(text)) && count < MAX_CSS_RULES) {
    count += 1;
    const classes = declarationClasses(m[2]);
    if (classes.length === 0) continue;
    for (const raw of m[1].split(",")) {
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

const TOKEN_RE =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([a-zA-Z][\w:.-]*)\s*>|<([a-zA-Z][\w:.-]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;

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

export type ReaderChunk = { html: string; text: string; images: number[] };
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
};

function frame(tag: string, allowed: boolean, dropped: boolean, classes = "", id = ""): Frame {
  return { tag, allowed, dropped, classes, id, html: [], text: [], images: [] };
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
  const inDrop = () => stack.some((f) => f.dropped);

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

  function appendText(raw: string) {
    if (!raw || inDrop()) return;
    const f = stack[stack.length - 1];
    const t = cleanText(raw);
    f.html.push(t);
    f.text.push(t);
  }

  function emit(rendered: string, text: string, images: number[]) {
    const parent = stack[stack.length - 1];
    if (parent === root) {
      flushRoot();
      if (text.trim() || images.length > 0) chunks.push({ html: rendered, text, images });
    } else {
      parent.html.push(rendered);
      parent.text.push(text);
      parent.images.push(...images);
    }
  }

  // Closes every frame above stack[idx - 1], innermost first.
  function closeFrom(idx: number) {
    while (stack.length > idx) {
      const done = stack.pop()!;
      if (done.dropped) continue;
      const inner = done.html.join("");
      const text = done.text.join("");
      let rendered = inner;
      if (done.allowed) {
        const classAttr = done.classes ? ` class="${done.classes}"` : "";
        const idAttr = done.id ? ` id="${done.id}"` : "";
        rendered = `<${done.tag}${idAttr}${classAttr}>${inner}</${done.tag}>`;
      } else if (done.classes) {
        // An unwrapped container (section, a, ...) that carried layout:
        // keep the layout on a neutral wrapper.
        rendered = `<div class="${done.classes}">${inner}</div>`;
      }
      emit(rendered, text, done.images);
    }
  }

  const capped = bodyHtml.length > MAX_READER_DOCUMENT_CHARS ? bodyHtml.slice(0, MAX_READER_DOCUMENT_CHARS) : bodyHtml;
  const re = new RegExp(TOKEN_RE.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(capped))) {
    appendText(capped.slice(last, m.index));
    last = re.lastIndex;
    const [, closeName, openName, attrs = "", selfMark] = m;

    if (closeName) {
      const name = closeName.toLowerCase();
      const idx = stack.map((f) => f.tag).lastIndexOf(name);
      if (idx <= 0) continue;
      closeFrom(idx);
      continue;
    }

    if (!openName) continue;
    const name = openName.toLowerCase();
    const local = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
    const selfClosing = selfMark === "/" || VOID_TAGS.has(name);

    if (inDrop() || DROP_ENTIRELY_TAGS.has(name) || DROP_ENTIRELY_TAGS.has(local)) {
      if (!selfClosing) stack.push(frame(name, false, true));
      continue;
    }

    if (name === "img") {
      const src = readAttr(attrs, "src");
      const index = src ? ctx.registerImage(src) : null;
      if (index !== null) {
        const alt = readAttr(attrs, "alt") ?? "";
        const f = stack[stack.length - 1];
        f.html.push(`<img alt="${escapeAttr(decodeBasicEntities(alt).replace(/\u0000/g, "").slice(0, 300))}" src="${IMAGE_TOKEN_PREFIX}${index}${IMAGE_TOKEN_SUFFIX}">`);
        f.images.push(index);
      }
      continue;
    }
    if (name === "br" || name === "hr") {
      stack[stack.length - 1].html.push(`<${name}>`);
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
    stack.push(frame(name, allowed, false, classes, id));
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
