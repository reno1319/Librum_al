// W4: reads the chapters of the preview copy of a Word-made ebook
// (docx-actions.ts, "<uid>/tmp/preview/<uuid>.epub") in the author's
// browser, without ever putting the file's own markup into the page:
// a small tokenizer turns each chapter into plain nodes with an allow-
// list of tags and attributes, and React renders those nodes (so text
// is always escaped and no attribute outside the list can appear). The
// file is Librum's own output, but it sits in the author's own storage
// folder and is read back, so it is treated as untrusted anyway.

export type PreviewNode = string | PreviewElement;
export type PreviewElement = { tag: PreviewTag; attrs: Record<string, string>; children: PreviewNode[] };

const TAGS = [
  "p", "h1", "h2", "h3", "h4", "blockquote", "em", "strong", "i", "b", "u", "br", "hr",
  "ul", "ol", "li", "sup", "sub", "a", "img", "span",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption",
] as const;
export type PreviewTag = (typeof TAGS)[number];
const TAG_SET = new Set<string>(TAGS);
const VOID_TAGS = new Set(["br", "hr", "img"]);
// Content that is never text for the reader.
const DROP_WITH_CONTENT = new Set(["script", "style", "head", "title", "svg", "math", "iframe", "object", "template"]);

export const PREVIEW_PARAGRAPH_CLASSES = ["scene-break", "center", "right", "verse", "verse-stanza", "verse-indent"] as const;
const P_CLASSES = new Set<string>(PREVIEW_PARAGRAPH_CLASSES);
export const PREVIEW_IMAGE_SRC_RE = /^images\/img-\d{1,4}\.(?:png|jpg|gif)$/;
const NUMBER_RE = /^\d{1,7}$/;

// Total node budget per chapter: a chapter is rendered on its own, and
// this bounds a hostile or broken file.
export const MAX_PREVIEW_NODES = 400_000;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m;
  });
}

function readAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const m of raw.matchAll(re)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? "");
  return out;
}

function safeAttrs(tag: PreviewTag, attrs: Record<string, string>): Record<string, string> | null {
  const out: Record<string, string> = {};
  switch (tag) {
    case "p":
      if (attrs.class && P_CLASSES.has(attrs.class)) out.class = attrs.class;
      break;
    case "span":
      if (attrs["data-p"] && NUMBER_RE.test(attrs["data-p"])) out["data-p"] = attrs["data-p"];
      if (attrs["data-s"] && NUMBER_RE.test(attrs["data-s"])) out["data-s"] = attrs["data-s"];
      break;
    case "img":
      // Only the ebook's own pictures, resolved by the screen to the
      // files inside the same EPUB. Anything else: no picture.
      if (!attrs.src || !PREVIEW_IMAGE_SRC_RE.test(attrs.src)) return null;
      out.src = attrs.src;
      out.alt = (attrs.alt ?? "").slice(0, 500);
      break;
    case "td":
    case "th":
      for (const k of ["colspan", "rowspan"]) if (attrs[k] && /^\d{1,2}$/.test(attrs[k])) out[k] = attrs[k];
      break;
    default:
      break;
  }
  return out;
}

// Parses the <body> of one chapter page. Unknown tags are dropped but
// their text kept; script-like elements are dropped with their content.
export function parseChapterXhtml(xhtml: string): PreviewNode[] {
  const open = xhtml.search(/<body\b[^>]*>/i);
  if (open < 0) return [];
  const start = xhtml.indexOf(">", open) + 1;
  const end = xhtml.lastIndexOf("</body>");
  const body = xhtml.slice(start, end > start ? end : xhtml.length);

  const root: PreviewElement = { tag: "span", attrs: {}, children: [] };
  // One frame per open tag: a kept element, an unknown tag whose text
  // is kept ("drop"), or a script-like tag skipped with its content.
  type Frame = { name: string; kind: "el" | "drop" | "skip"; element?: PreviewElement };
  const frames: Frame[] = [];
  const parent = () => {
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i].kind === "el") return frames[i].element!;
    return root;
  };
  let skipDepth = 0;
  let nodes = 0;

  const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>|[^<]+|</g;
  for (const m of body.matchAll(re)) {
    if (nodes > MAX_PREVIEW_NODES) break;
    const token = m[0];
    if (token.startsWith("<!--") || token.startsWith("<![CDATA[")) continue;
    const name = m[1]?.toLowerCase();
    if (!name) {
      if (skipDepth > 0) continue;
      const text = token === "<" ? "<" : decodeEntities(token);
      if (text) {
        parent().children.push(text);
        nodes++;
      }
      continue;
    }
    if (token.startsWith("</")) {
      let at = -1;
      for (let i = frames.length - 1; i >= 0; i--) {
        if (frames[i].name === name) {
          at = i;
          break;
        }
      }
      if (at < 0) continue;
      while (frames.length > at) {
        if (frames.pop()!.kind === "skip") skipDepth--;
      }
      continue;
    }
    const selfClosing = m[3] === "/" || VOID_TAGS.has(name);
    if (skipDepth > 0 || DROP_WITH_CONTENT.has(name)) {
      if (!selfClosing) {
        frames.push({ name, kind: "skip" });
        skipDepth++;
      }
      continue;
    }
    if (!TAG_SET.has(name)) {
      if (!selfClosing) frames.push({ name, kind: "drop" });
      continue;
    }
    const tag = name as PreviewTag;
    const attrs = safeAttrs(tag, readAttrs(m[2] ?? ""));
    if (!attrs) {
      if (!selfClosing) frames.push({ name, kind: "drop" });
      continue;
    }
    const element: PreviewElement = { tag, attrs, children: [] };
    parent().children.push(element);
    nodes++;
    if (!selfClosing) frames.push({ name, kind: "el", element });
  }
  return root.children;
}

export function textOf(node: PreviewNode): string {
  return typeof node === "string" ? node : node.children.map(textOf).join("");
}

// The Word paragraph numbers a chapter page carries.
export function marksInChapter(xhtml: string): { paragraphs: number[]; sceneBreaks: number[] } {
  const paragraphs: number[] = [];
  const sceneBreaks: number[] = [];
  for (const m of xhtml.matchAll(/data-([ps])="(\d{1,7})"/g)) (m[1] === "p" ? paragraphs : sceneBreaks).push(Number(m[2]));
  return { paragraphs, sceneBreaks };
}

// The ebook's own stylesheet, limited to the preview box: every rule's
// selectors are prefixed with `scope` ("body" becomes the box itself).
// Rules with url(), @import or anything unexpected are left out.
export function scopeStylesheet(css: string, scope: string): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of css.slice(0, 50_000).replace(/@[^{};]*;/g, "").matchAll(re)) {
    const selectors = m[1].trim();
    const decls = m[2].trim();
    if (/@|url\s*\(|expression|\\|<|javascript:/i.test(selectors + decls)) continue;
    if (!/^[a-z0-9 ,.:>+~()*#_-]+$/i.test(selectors)) continue;
    const scoped = selectors
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s === "body" ? scope : s.startsWith("body ") || s.startsWith("body>") ? `${scope}${s.slice(4)}` : `${scope} ${s}`))
      .join(", ");
    out.push(`${scoped} { ${decls} }`);
  }
  return out.join("\n");
}
