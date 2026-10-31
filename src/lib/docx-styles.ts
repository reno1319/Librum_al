import { childElems, firstChild, getAttr, onOff, parseXml, serializeXml, type XElem } from "@/lib/docx-xml";

// W3: what the clean-up pass needs from word/styles.xml and
// word/numbering.xml -- each paragraph style's name, alignment, font
// size, bold/italic/caps, "page break before" and list numbering,
// following Word's basedOn chain. Nothing here is trusted beyond being
// read as data.

export type RunLook = { size: number | null; bold: boolean | null; italic: boolean | null; caps: boolean | null };

export type StyleInfo = {
  id: string;
  name: string;
  type: string;
  basedOn: string | null;
  align: string | null;
  pageBreakBefore: boolean | null;
  numId: string | null;
  ilvl: number | null;
  run: RunLook;
};

export type StyleSheet = {
  styles: Map<string, StyleInfo>;
  defaultParagraphStyle: string | null;
  defaults: RunLook;
};

export function readRunLook(rPr: XElem | null): RunLook {
  if (!rPr) return { size: null, bold: null, italic: null, caps: null };
  const sz = firstChild(rPr, "w:sz");
  const size = sz ? Number(getAttr(sz, "w:val")) : NaN;
  return {
    size: Number.isFinite(size) && size > 0 ? size : null,
    bold: onOff(firstChild(rPr, "w:b")),
    italic: onOff(firstChild(rPr, "w:i")),
    caps: onOff(firstChild(rPr, "w:caps")),
  };
}

export function readStyles(xml: string | null): StyleSheet {
  const sheet: StyleSheet = {
    styles: new Map(),
    defaultParagraphStyle: null,
    defaults: { size: null, bold: null, italic: null, caps: null },
  };
  if (!xml) return sheet;
  const root = parseXml(xml);
  const stylesEl = childElems(root).find((e) => e.name === "w:styles");
  if (!stylesEl) return sheet;
  const docDefaults = firstChild(stylesEl, "w:docDefaults");
  const rPrDefault = docDefaults && firstChild(docDefaults, "w:rPrDefault");
  if (rPrDefault) sheet.defaults = readRunLook(firstChild(rPrDefault, "w:rPr"));
  for (const st of childElems(stylesEl, "w:style")) {
    const id = getAttr(st, "w:styleId");
    if (!id) continue;
    const type = getAttr(st, "w:type") ?? "paragraph";
    const nameEl = firstChild(st, "w:name");
    const basedOnEl = firstChild(st, "w:basedOn");
    const pPr = firstChild(st, "w:pPr");
    const jc = pPr && firstChild(pPr, "w:jc");
    const numPr = pPr && firstChild(pPr, "w:numPr");
    const numIdEl = numPr && firstChild(numPr, "w:numId");
    const ilvlEl = numPr && firstChild(numPr, "w:ilvl");
    const info: StyleInfo = {
      id,
      name: (nameEl && getAttr(nameEl, "w:val")) || id,
      type,
      basedOn: basedOnEl ? getAttr(basedOnEl, "w:val") : null,
      align: jc ? getAttr(jc, "w:val") : null,
      pageBreakBefore: pPr ? onOff(firstChild(pPr, "w:pageBreakBefore")) : null,
      numId: numIdEl ? getAttr(numIdEl, "w:val") : null,
      ilvl: ilvlEl ? Number(getAttr(ilvlEl, "w:val")) || 0 : null,
      run: readRunLook(firstChild(st, "w:rPr")),
    };
    sheet.styles.set(id, info);
    if (type === "paragraph" && getAttr(st, "w:default") === "1") sheet.defaultParagraphStyle = id;
  }
  return sheet;
}

// Walks a style and its basedOn ancestors, nearest first.
export function styleChain(sheet: StyleSheet, id: string | null): StyleInfo[] {
  const chain: StyleInfo[] = [];
  const seen = new Set<string>();
  let cur = id ?? sheet.defaultParagraphStyle;
  while (cur && !seen.has(cur) && chain.length < 20) {
    seen.add(cur);
    const st = sheet.styles.get(cur);
    if (!st) break;
    chain.push(st);
    cur = st.basedOn;
  }
  return chain;
}

export function styleName(sheet: StyleSheet, id: string | null): string {
  if (!id) return "";
  return sheet.styles.get(id)?.name ?? id;
}

// Word stores built-in heading names in English ("heading 1") whatever
// the interface language.
export function headingLevelOfStyle(sheet: StyleSheet, id: string | null): number | null {
  for (const st of styleChain(sheet, id).slice(0, 1)) {
    const m = st.name.trim().match(/^heading ([1-9])$/i);
    if (m) return Number(m[1]);
  }
  return null;
}

// ---------- numbering ----------

type Level = { numFmt: string; lvlText: string; start: number };
export type Numbering = {
  levels: Map<string, Map<number, Level>>; // numId -> ilvl -> level
  counters: Map<string, number[]>;
};

export function readNumbering(xml: string | null): Numbering {
  const numbering: Numbering = { levels: new Map(), counters: new Map() };
  if (!xml) return numbering;
  const root = parseXml(xml);
  const top = childElems(root).find((e) => e.name === "w:numbering");
  if (!top) return numbering;
  const abstract = new Map<string, Map<number, Level>>();
  for (const an of childElems(top, "w:abstractNum")) {
    const id = getAttr(an, "w:abstractNumId");
    if (id === null) continue;
    const lv = new Map<number, Level>();
    for (const l of childElems(an, "w:lvl")) {
      const ilvl = Number(getAttr(l, "w:ilvl")) || 0;
      const fmt = firstChild(l, "w:numFmt");
      const text = firstChild(l, "w:lvlText");
      const start = firstChild(l, "w:start");
      lv.set(ilvl, {
        numFmt: (fmt && getAttr(fmt, "w:val")) || "decimal",
        lvlText: (text && getAttr(text, "w:val")) ?? "",
        start: start ? Number(getAttr(start, "w:val")) || 1 : 1,
      });
    }
    abstract.set(id, lv);
  }
  for (const num of childElems(top, "w:num")) {
    const id = getAttr(num, "w:numId");
    const ref = firstChild(num, "w:abstractNumId");
    const abs = ref && getAttr(ref, "w:val");
    if (id && abs && abstract.has(abs)) numbering.levels.set(id, abstract.get(abs)!);
  }
  return numbering;
}

const ROMAN: [number, string][] = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
  [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];
function toRoman(n: number): string {
  let out = "";
  for (const [v, s] of ROMAN) while (n >= v) { out += s; n -= v; }
  return out || String(n);
}
function toLetters(n: number): string {
  const letter = String.fromCharCode(64 + (((n - 1) % 26) + 1));
  return letter.repeat(Math.floor((n - 1) / 26) + 1);
}
function formatNumber(n: number, fmt: string): string {
  switch (fmt) {
    case "upperRoman": return toRoman(n);
    case "lowerRoman": return toRoman(n).toLowerCase();
    case "upperLetter": return toLetters(n);
    case "lowerLetter": return toLetters(n).toLowerCase();
    case "decimalZero": return n < 10 ? `0${n}` : String(n);
    default: return String(n);
  }
}

// Advances the counter for one numbered paragraph (in document order)
// and returns the label Word would show ("1.", "IV", "2.3") -- or null
// for bullets and anything with no visible number.
export function nextNumberLabel(numbering: Numbering, numId: string, ilvl: number): string | null {
  const levels = numbering.levels.get(numId);
  if (!levels) return null;
  const level = levels.get(ilvl);
  if (!level) return null;
  const counters = numbering.counters.get(numId) ?? [];
  for (let i = 0; i <= ilvl; i++) {
    if (counters[i] === undefined) counters[i] = (levels.get(i)?.start ?? 1) - (i === ilvl ? 1 : 0);
  }
  counters[ilvl] += 1;
  counters.length = ilvl + 1; // deeper levels restart
  numbering.counters.set(numId, counters);
  if (level.numFmt === "bullet" || level.numFmt === "none") return null;
  const label = level.lvlText.replace(/%([1-9])/g, (_w, d: string) => {
    const i = Number(d) - 1;
    const lv = levels.get(i);
    return formatNumber(counters[i] ?? lv?.start ?? 1, lv?.numFmt ?? "decimal");
  });
  return label.trim() || null;
}

// ---------- Librum's own styles ----------

// The clean-up pass marks paragraphs with these styles; docx-converter's
// Mammoth style map turns each into its HTML. The ids are prefixed so
// they can't clash with the author's own styles.
export const LIBRUM_STYLES = {
  chapter: { id: "LibrumChapter", name: "Librum Chapter" },
  subheading: { id: "LibrumSubheading", name: "Librum Subheading" },
  sceneBreak: { id: "LibrumSceneBreak", name: "Librum Scene Break" },
  center: { id: "LibrumCenter", name: "Librum Center" },
  right: { id: "LibrumRight", name: "Librum Right" },
  verse: { id: "LibrumVerse", name: "Librum Verse" },
  verseStanza: { id: "LibrumVerseStanza", name: "Librum Verse Stanza" },
  verseIndent: { id: "LibrumVerseIndent", name: "Librum Verse Indent" },
  // W4: a Heading 1 the author says is not a chapter.
  plain: { id: "LibrumPlain", name: "Librum Plain" },
} as const;
export type LibrumStyleKey = keyof typeof LIBRUM_STYLES;

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

// Returns styles.xml with Librum's styles added (or a new minimal
// styles.xml when the file had none).
export function addLibrumStyles(stylesXml: string | null): string {
  const defs = Object.values(LIBRUM_STYLES)
    .map((s) => `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${s.id}"><w:name w:val="${s.name}"/></w:style>`)
    .join("");
  if (!stylesXml) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles xmlns:w="${W_NS}">${defs}</w:styles>`;
  }
  const root = parseXml(stylesXml);
  const stylesEl = childElems(root).find((e) => e.name === "w:styles");
  if (!stylesEl) throw new Error("styles.xml has no w:styles");
  const extra = parseXml(defs);
  stylesEl.children.push(...extra.children);
  stylesEl.selfClosing = false;
  return serializeXml(root);
}
