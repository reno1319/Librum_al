import {
  decodeXmlText,
  el,
  findAll,
  firstChild,
  getAttr,
  onOff,
  textNode,
  type XElem,
  type XNode,
} from "@/lib/docx-xml";
import {
  headingLevelOfStyle,
  readRunLook,
  styleChain,
  styleName,
  type RunLook,
  type StyleSheet,
} from "@/lib/docx-styles";
import { trimSpace, trimSpaceEnd } from "@/lib/docx-trim";

// W3: reads one Word paragraph (<w:p>) the way the clean-up pass needs
// it -- its visible text and how it looks (alignment, font size, bold,
// italic, capitals, page breaks) -- and edits it in place.

export type ParaFacts = {
  node: XElem;
  text: string;
  trimmed: string;
  styleId: string | null;
  styleName: string;
  headingLevel: number | null;
  align: string | null;
  size: number | null;
  bold: boolean;
  italic: boolean;
  caps: boolean;
  breakBefore: boolean;
  breakAfter: boolean;
  empty: boolean;
  hasObject: boolean;
  hasNoteRef: boolean;
  dropCap: boolean;
  num: { numId: string; ilvl: number } | null;
  leadingTabs: number;
  lineBreaks: number;
  // A line of Word's own contents list: a link to a "_Toc" bookmark.
  tocLink: boolean;
};

// Subtrees whose text is not part of the paragraph itself: Word's
// properties, text boxes (Mammoth moves their text after the
// paragraph) and the old-Word fallback copy of drawings.
const SKIP = new Set(["w:pPr", "w:rPr", "w:txbxContent", "mc:Fallback", "w:del", "w:moveFrom", "w:instrText", "w:delText"]);
const OBJECTS = new Set(["w:drawing", "w:pict", "w:object", "w:txbxContent"]);
const WS_RE = /^[\s ​﻿]*$/;

type EffectiveLook = { size: number; bold: boolean; italic: boolean; caps: boolean };
type Item =
  | { kind: "text"; text: string; look: EffectiveLook }
  | { kind: "tab" }
  | { kind: "line" }
  | { kind: "page" }
  | { kind: "object" }
  | { kind: "note" };

function effectiveLook(sheet: StyleSheet, paraStyle: string | null, rPr: XElem | null): EffectiveLook {
  const layers: RunLook[] = [readRunLook(rPr)];
  const rStyleEl = rPr && firstChild(rPr, "w:rStyle");
  const rStyle = rStyleEl && getAttr(rStyleEl, "w:val");
  if (rStyle) for (const st of styleChain(sheet, rStyle)) layers.push(st.run);
  for (const st of styleChain(sheet, paraStyle)) layers.push(st.run);
  layers.push(sheet.defaults);
  const pick = <K extends keyof RunLook>(k: K) => {
    for (const l of layers) if (l[k] !== null) return l[k];
    return null;
  };
  return {
    size: (pick("size") as number | null) ?? 24,
    bold: (pick("bold") as boolean | null) ?? false,
    italic: (pick("italic") as boolean | null) ?? false,
    caps: (pick("caps") as boolean | null) ?? false,
  };
}

function collectItems(p: XElem, sheet: StyleSheet, paraStyle: string | null): Item[] {
  const items: Item[] = [];
  const visit = (node: XElem) => {
    for (const c of node.children) {
      if (c.kind !== "el" || SKIP.has(c.name)) {
        if (c.kind === "el" && c.name === "w:txbxContent") items.push({ kind: "object" });
        continue;
      }
      if (c.name === "w:r") {
        const look = effectiveLook(sheet, paraStyle, firstChild(c, "w:rPr"));
        for (const r of c.children) {
          if (r.kind !== "el") continue;
          if (r.name === "w:t") items.push({ kind: "text", text: textOf(r), look });
          else if (r.name === "w:tab") items.push({ kind: "tab" });
          else if (r.name === "w:br") items.push(getAttr(r, "w:type") === "page" ? { kind: "page" } : { kind: "line" });
          else if (r.name === "w:cr") items.push({ kind: "line" });
          else if (r.name === "w:footnoteReference" || r.name === "w:endnoteReference") items.push({ kind: "note" });
          else if (OBJECTS.has(r.name) || r.name === "mc:AlternateContent") items.push({ kind: "object" });
        }
        continue;
      }
      if (OBJECTS.has(c.name)) {
        items.push({ kind: "object" });
        continue;
      }
      visit(c);
    }
  };
  visit(p);
  return items;
}

function textOf(t: XElem): string {
  let s = "";
  for (const c of t.children) if (c.kind === "text") s += decodeXmlText(c.raw);
  return s;
}

export function readParagraph(p: XElem, sheet: StyleSheet): ParaFacts {
  const pPr = firstChild(p, "w:pPr");
  const pStyleEl = pPr && firstChild(pPr, "w:pStyle");
  const styleId = (pStyleEl && getAttr(pStyleEl, "w:val")) || null;
  const chain = styleChain(sheet, styleId);
  const jcEl = pPr && firstChild(pPr, "w:jc");
  const align = (jcEl && getAttr(jcEl, "w:val")) ?? chain.find((s) => s.align)?.align ?? null;
  let pageBreakBefore = pPr ? onOff(firstChild(pPr, "w:pageBreakBefore")) : null;
  if (pageBreakBefore === null) pageBreakBefore = chain.find((s) => s.pageBreakBefore !== null)?.pageBreakBefore ?? false;
  const sectPr = pPr && firstChild(pPr, "w:sectPr");
  const sectType = sectPr && firstChild(sectPr, "w:type");
  const sectionBreak = !!sectPr && (!sectType || getAttr(sectType, "w:val") !== "continuous");
  const framePr = pPr && firstChild(pPr, "w:framePr");
  const dropCapVal = framePr && getAttr(framePr, "w:dropCap");
  const numPr = pPr && firstChild(pPr, "w:numPr");
  let num: ParaFacts["num"] = null;
  if (numPr) {
    const id = firstChild(numPr, "w:numId");
    const lv = firstChild(numPr, "w:ilvl");
    const numId = id && getAttr(id, "w:val");
    if (numId && numId !== "0") num = { numId, ilvl: (lv && Number(getAttr(lv, "w:val"))) || 0 };
  } else {
    const st = chain.find((s) => s.numId !== null);
    if (st && st.numId && st.numId !== "0") num = { numId: st.numId, ilvl: st.ilvl ?? 0 };
  }

  const items = collectItems(p, sheet, styleId);
  let text = "";
  let sawText = false;
  let breakBefore = pageBreakBefore;
  let breakAfter = false;
  let hasObject = false;
  let hasNoteRef = false;
  let leadingTabs = 0;
  let lineBreaks = 0;
  let leading = true;
  const sizeWeight = new Map<number, number>();
  let chars = 0;
  let boldChars = 0;
  let italicChars = 0;
  let capsChars = 0;
  for (const it of items) {
    if (it.kind === "text") {
      text += it.text;
      const visible = it.text.replace(/[\s ​﻿]/g, "").length;
      if (leading) {
        const lead = it.text.match(/^[\s ​﻿]*/)![0];
        leadingTabs += lead.split("\t").length - 1;
      }
      if (visible > 0) {
        sawText = true;
        leading = false;
        breakAfter = false;
        chars += visible;
        sizeWeight.set(it.look.size, (sizeWeight.get(it.look.size) ?? 0) + visible);
        if (it.look.bold) boldChars += visible;
        if (it.look.italic) italicChars += visible;
        if (it.look.caps) capsChars += visible;
      }
    } else if (it.kind === "tab") {
      text += "\t";
      if (leading) leadingTabs++;
    } else if (it.kind === "line") {
      text += "\n";
      if (sawText) lineBreaks++;
    } else if (it.kind === "page") {
      if (!sawText) breakBefore = true;
      else breakAfter = true;
    } else if (it.kind === "object") {
      hasObject = true;
      leading = false;
    } else if (it.kind === "note") {
      hasNoteRef = true;
    }
  }
  if (sectionBreak) breakAfter = true;
  let size: number | null = null;
  let best = -1;
  for (const [s, w] of sizeWeight) if (w > best) { best = w; size = s; }
  const trimmed = trimSpace(text);
  const letters = trimmed.replace(/[^\p{L}]/gu, "");
  const upperCase = letters.length >= 3 && letters === letters.toLocaleUpperCase("sq") && letters !== letters.toLocaleLowerCase("sq");
  return {
    node: p,
    text,
    trimmed,
    styleId,
    styleName: styleName(sheet, styleId),
    headingLevel: headingLevelOfStyle(sheet, styleId),
    align,
    size,
    bold: chars > 0 && boldChars === chars,
    italic: chars > 0 && italicChars === chars,
    caps: chars > 0 && (upperCase || capsChars === chars),
    breakBefore,
    breakAfter,
    empty: !hasObject && !hasNoteRef && WS_RE.test(text),
    hasObject,
    hasNoteRef,
    dropCap: !!dropCapVal && dropCapVal !== "none",
    num,
    leadingTabs,
    lineBreaks,
    tocLink: findAll(p, "w:hyperlink").some((h) => /^_Toc[\w-]*$/.test(getAttr(h, "w:anchor") ?? "")),
  };
}

// ---------- editing ----------

export function setParagraphStyle(p: XElem, styleId: string) {
  let pPr = firstChild(p, "w:pPr");
  if (!pPr) {
    pPr = el("w:pPr");
    pPr.selfClosing = false;
    p.children.unshift(pPr);
    p.selfClosing = false;
  }
  pPr.selfClosing = false;
  pPr.children = pPr.children.filter((c) => !(c.kind === "el" && c.name === "w:pStyle"));
  pPr.children.unshift(el("w:pStyle", ` w:val="${styleId}"`));
}

export function removeNumbering(p: XElem) {
  const pPr = firstChild(p, "w:pPr");
  if (!pPr) return;
  pPr.children = pPr.children.filter((c) => !(c.kind === "el" && c.name === "w:numPr"));
  // A style's own numbering is switched off with numId 0.
  pPr.children.push(el("w:numPr", "", [el("w:numId", ' w:val="0"')]));
}

export function contentNodes(p: XElem): XNode[] {
  return p.children.filter((c) => !(c.kind === "el" && c.name === "w:pPr"));
}

export function insertAtStart(p: XElem, nodes: XNode[]) {
  const at = p.children.findIndex((c) => c.kind === "el" && c.name === "w:pPr") + 1;
  p.children.splice(at, 0, ...nodes);
  p.selfClosing = false;
}

export function appendNodes(p: XElem, nodes: XNode[]) {
  p.children.push(...nodes);
  p.selfClosing = false;
}

export function textRun(text: string): XElem {
  return el("w:r", "", [el("w:t", ' xml:space="preserve"', [textNode(text)])]);
}

export function lineBreakRun(): XElem {
  return el("w:r", "", [el("w:br")]);
}

// The paragraph's editable pieces in reading order: text nodes, tabs
// and line breaks inside runs (not inside text boxes).
type Piece = { parent: XElem; node: XElem };
function pieces(p: XElem): Piece[] {
  const out: Piece[] = [];
  const visit = (node: XElem) => {
    for (const c of node.children) {
      if (c.kind !== "el" || SKIP.has(c.name) || OBJECTS.has(c.name)) continue;
      if (c.name === "w:r") {
        for (const r of c.children) {
          if (r.kind === "el" && (r.name === "w:t" || r.name === "w:tab" || r.name === "w:br" || r.name === "w:cr")) {
            out.push({ parent: c, node: r });
          }
        }
        continue;
      }
      visit(c);
    }
  };
  visit(p);
  return out;
}

function setText(t: XElem, text: string) {
  t.children = text ? [textNode(text)] : [];
  t.attrs = ' xml:space="preserve"';
  t.selfClosing = text.length === 0;
}

function removePiece(piece: Piece) {
  piece.parent.children = piece.parent.children.filter((c) => c !== piece.node);
}

const LEAD_WS_RE = /^[\s ​﻿]+/;

// Removes tabs and spaces typed at the start of the paragraph. Returns
// true when anything was removed.
export function stripLeadingWhitespace(p: XElem): boolean {
  let changed = false;
  for (const piece of pieces(p)) {
    const n = piece.node;
    if (n.name === "w:tab") {
      removePiece(piece);
      changed = true;
      continue;
    }
    if (n.name === "w:t") {
      const t = textOf(n);
      const stripped = t.replace(LEAD_WS_RE, "");
      if (stripped !== t) {
        setText(n, stripped);
        changed = true;
      }
      if (stripped.length > 0) return changed;
      continue;
    }
    // A line break or anything else before the text: stop.
    return changed;
  }
  return changed;
}

// Removes line breaks, tabs and spaces left after the last word (often
// typed just before a page break).
export function stripTrailingWhitespace(p: XElem): boolean {
  let changed = false;
  const list = pieces(p);
  for (let i = list.length - 1; i >= 0; i--) {
    const piece = list[i];
    const n = piece.node;
    if (n.name === "w:br" && getAttr(n, "w:type") === "page") continue;
    if (n.name === "w:tab" || n.name === "w:br" || n.name === "w:cr") {
      removePiece(piece);
      changed = true;
      continue;
    }
    const t = textOf(n);
    const stripped = trimSpaceEnd(t);
    if (stripped !== t) {
      setText(n, stripped);
      changed = true;
    }
    if (stripped.length > 0) return changed;
  }
  return changed;
}

// Rewrites the paragraph's text through `transform`, which receives the
// whole text (all runs joined) and returns, per code point, what it
// becomes. Run boundaries and formatting are kept.
export function transformText(p: XElem, transform: (text: string) => string[]): void {
  const texts = pieces(p).filter((x) => x.node.name === "w:t");
  if (texts.length === 0) return;
  const parts = texts.map((x) => Array.from(textOf(x.node)));
  const out = transform(parts.map((a) => a.join("")).join(""));
  let k = 0;
  texts.forEach((x, idx) => {
    const len = parts[idx].length;
    const next = out.slice(k, k + len).join("");
    k += len;
    if (next !== parts[idx].join("")) setText(x.node, next);
  });
}

function cloneShallow(e: XElem): XElem {
  return { kind: "el", name: e.name, attrs: e.attrs, selfClosing: e.selfClosing, children: e.children.slice() };
}

// Splits a paragraph at its typed line breaks (Shift+Enter used instead
// of Enter) into separate paragraphs with the same paragraph settings.
// Only breaks directly inside the paragraph's own runs split it; a
// break inside a link stays a line break.
export function splitAtLineBreaks(p: XElem): XElem[] {
  const pPr = firstChild(p, "w:pPr");
  const out: XElem[] = [];
  let current: XNode[] = [];
  const flush = () => {
    const np: XElem = { kind: "el", name: "w:p", attrs: p.attrs, selfClosing: false, children: [] };
    if (pPr) np.children.push(cloneShallow(pPr));
    np.children.push(...current);
    out.push(np);
    current = [];
  };
  for (const c of contentNodes(p)) {
    if (c.kind !== "el" || c.name !== "w:r") {
      current.push(c);
      continue;
    }
    const rPr = firstChild(c, "w:rPr");
    let seg: XNode[] = [];
    const pushSeg = () => {
      if (seg.some((x) => x.kind === "el")) {
        current.push({ kind: "el", name: "w:r", attrs: c.attrs, selfClosing: false, children: [...(rPr ? [rPr] : []), ...seg] });
      }
      seg = [];
    };
    for (const r of c.children) {
      if (r === rPr) continue;
      if (r.kind === "el" && (r.name === "w:br" || r.name === "w:cr") && getAttr(r, "w:type") !== "page") {
        pushSeg();
        flush();
        continue;
      }
      seg.push(r);
    }
    pushSeg();
  }
  flush();
  return out;
}
