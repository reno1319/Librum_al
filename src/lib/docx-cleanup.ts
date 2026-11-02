import type JSZip from "jszip";
import {
  childElems,
  el,
  findAll,
  firstChild,
  getAttr,
  walk,
  parseXml,
  serializeXml,
  type XElem,
  type XNode,
} from "@/lib/docx-xml";
import {
  addLibrumStyles,
  LIBRUM_STYLES,
  nextNumberLabel,
  readNumbering,
  readStyles,
} from "@/lib/docx-styles";
import {
  appendNodes,
  contentNodes,
  insertAtStart,
  lineBreakRun,
  readParagraph,
  removeNumbering,
  setParagraphStyle,
  splitAtLineBreaks,
  stripLeadingWhitespace,
  stripTrailingWhitespace,
  textRun,
  transformText,
} from "@/lib/docx-paragraphs";
import { planStructure, type Block, type CleanupGuess } from "@/lib/docx-structure";
import type { MissingLetters } from "@/lib/docx-letters";
import {
  detectDialogueDash,
  detectQuoteStyle,
  emptyTidyCounts,
  tidyText,
  type QuoteStyle,
} from "@/lib/docx-text-tidy";

// W3: the Word clean-up pass. Runs before Mammoth (docx-converter.ts),
// on the part of the .docx Mammoth can't see -- word/document.xml with
// its font sizes, centering, page breaks and empty lines -- and writes
// a cleaned copy of the file:
//   - tracked changes accepted (answer 7a), Word/typed contents lists
//     removed, typed "***" markers and meaningful empty lines turned
//     into one "* * *" scene break, other empty lines removed;
//   - chapters typed by hand marked as Librum's chapter style (2+ signs,
//     answer 2a), "Kapitulli 1" + title merged (9a), Word's automatic
//     heading numbers written into the heading text, drop caps glued
//     back to their word;
//   - centered/right-aligned short lines and poems kept as such;
//   - tab/space indents removed, quotes/apostrophes/dashes tidied
//     (3b a, 6a; switchable for the preview).
// Everything it guessed is returned with a confidence level, so the
// author preview (W4) can show and undo it. If anything goes wrong the
// caller converts the original file exactly as before.

// Renato's answer 10b (31 Oct) kept W3 off Production until the author
// preview (W4) existed and had been tried on staging. That try-out
// passed (31 Oct, footnote test file), and his answers 1a/2a turn the
// pass (and the book-style paragraph CSS in epub-generator.ts) on
// everywhere, with one emergency off switch: DOCX_CLEANUP_OFF. Any
// non-empty value (after trimming spaces) turns the pass off, so a
// typo can only ever switch it off, never leave it on by mistake.
// Unset or empty means on. Server-only (no NEXT_PUBLIC_ prefix). With
// it off, conversion is exactly as it was before W3. On Vercel the
// switch takes effect after a redeploy.
export function cleanupPassEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const off = env.DOCX_CLEANUP_OFF;
  return off === undefined || off.trim() === "";
}

export const CLEANUP_SAMPLE_TEXT_MAX = 80;
// Above this the pass is skipped (the original file is converted as
// before): bounds the in-memory XML tree.
export const MAX_CLEANUP_DOCUMENT_XML_CHARS = 20_000_000;

export type CleanupOptions = {
  makeChapter?: number[];
  notChapter?: number[];
  keepLines?: number[];
  keepContents?: number[];
  keepTitleApart?: number[];
  sceneBreak?: number[];
  noSceneBreak?: number[];
  notSubheading?: number[];
  notVerse?: number[];
  keepCopyright?: number[];
  removeTitlePage?: number[];
  fixQuotes?: boolean;
  // W4: mark each paragraph with its Word paragraph number (a bookmark
  // Mammoth turns into <a id="lbp_N">), so the author preview can say
  // which line the author tapped. docx-converter.ts strips the marks
  // before the ebook is built, so the ebook is the same with or without.
  markParagraphs?: boolean;
};

export const PARAGRAPH_MARK_PREFIX = "lbp_";
export const SCENE_BREAK_MARK_PREFIX = "lbs_";

export type CleanupReport = {
  applied: boolean;
  chapterSource: "styles" | "detected" | "none";
  chapters: number;
  subheadings: number;
  sceneBreaks: number;
  quoteStyle: QuoteStyle | "off";
  fixes: {
    emptyLinesRemoved: number;
    indentsRemoved: number;
    contentsLinesRemoved: number;
    // BD3 patch 2: lines of the author's own copyright page and typed
    // title page (Librum's own page replaces them at download).
    frontLinesRemoved: number;
    quotes: number;
    apostrophes: number;
    ellipses: number;
    dashes: number;
    dropCapsJoined: number;
    headingNumbersAdded: number;
    paragraphsSplit: number;
    // W3 Part 2 (answer 6a): "Ã«" -> "ë" and the like.
    brokenLetters: number;
  };
  // W3 Part 2 (answer 4a): blank lines kept around centered/right lines
  // and poems that had empty lines around them in Word.
  gaps: number;
  // W3 Part 2: Word notes kept in the ebook (footnotes at the end of
  // their chapter, endnotes in the "Shënime" chapter); `dropped` = note
  // texts whose reference was not found in the book.
  notes: { footnotes: number; endnotes: number; dropped: number };
  // W3 Part 2 (answer 5a): words typed without ë/ç, when it looks like a
  // habit; reported only, never corrected.
  missingLetters: MissingLetters | null;
  trackedChanges: boolean;
  comments: boolean;
  guesses: CleanupGuess[];
};

export function emptyCleanupReport(): CleanupReport {
  return {
    applied: false,
    chapterSource: "none",
    chapters: 0,
    subheadings: 0,
    sceneBreaks: 0,
    quoteStyle: "off",
    fixes: {
      emptyLinesRemoved: 0,
      indentsRemoved: 0,
      contentsLinesRemoved: 0,
      frontLinesRemoved: 0,
      quotes: 0,
      apostrophes: 0,
      ellipses: 0,
      dashes: 0,
      dropCapsJoined: 0,
      headingNumbersAdded: 0,
      paragraphsSplit: 0,
      brokenLetters: 0,
    },
    gaps: 0,
    notes: { footnotes: 0, endnotes: 0, dropped: 0 },
    missingLetters: null,
    trackedChanges: false,
    comments: false,
    guesses: [],
  };
}

// Tracked changes: Word's "accept all".
const REMOVE_ON_ACCEPT = new Set([
  "w:del", "w:moveFrom", "w:pPrChange", "w:rPrChange", "w:sectPrChange", "w:tblPrChange",
  "w:trPrChange", "w:tcPrChange", "w:tblGridChange", "w:numberingChange",
  "w:moveFromRangeStart", "w:moveFromRangeEnd", "w:moveToRangeStart", "w:moveToRangeEnd",
]);
const UNWRAP_ON_ACCEPT = new Set(["w:ins", "w:moveTo"]);

function acceptTrackedChanges(node: XElem): boolean {
  let found = false;
  const go = (parent: XElem) => {
    const next: XNode[] = [];
    for (const c of parent.children) {
      if (c.kind === "el" && REMOVE_ON_ACCEPT.has(c.name)) {
        found = true;
        continue;
      }
      if (c.kind === "el" && UNWRAP_ON_ACCEPT.has(c.name)) {
        found = true;
        go(c);
        next.push(...c.children);
        continue;
      }
      if (c.kind === "el") go(c);
      next.push(c);
    }
    parent.children = next;
  };
  go(node);
  return found;
}

function isTocBlock(sdt: XElem): boolean {
  const sdtPr = firstChild(sdt, "w:sdtPr");
  if (!sdtPr) return false;
  for (const g of findAll(sdtPr, "w:docPartGallery")) {
    if (/table of contents/i.test(getAttr(g, "w:val") ?? "")) return true;
  }
  return false;
}

// W3 Part 2 (answer 4a): one blank line, however many empty lines the
// author typed. A non-breaking space keeps it through Mammoth (which
// drops empty paragraphs) and through the ebook's empty-element clean-up.
function gapParagraph(): XElem {
  const p = el("w:p", "", [textRun("\u00a0")]);
  setParagraphStyle(p, LIBRUM_STYLES.gap.id);
  return p;
}

function sceneBreakParagraph(): XElem {
  const p = el("w:p", "", [textRun("* * *")]);
  setParagraphStyle(p, LIBRUM_STYLES.sceneBreak.id);
  return p;
}

async function readPart(zip: JSZip, path: string): Promise<string | null> {
  const f = zip.file(path);
  return f ? f.async("string") : null;
}

// Rewrites `zip` in place. Returns the report; throws on anything
// unexpected (the caller then falls back to the original file).
export async function cleanUpDocx(zip: JSZip, options: CleanupOptions = {}): Promise<CleanupReport> {
  const report = emptyCleanupReport();
  const documentXml = await readPart(zip, "word/document.xml");
  if (!documentXml || documentXml.length > MAX_CLEANUP_DOCUMENT_XML_CHARS) return report;
  const stylesXml = await readPart(zip, "word/styles.xml");
  const sheet = readStyles(stylesXml);
  const numbering = readNumbering(await readPart(zip, "word/numbering.xml"));

  const root = parseXml(documentXml);
  const docEl = childElems(root).find((e) => e.name === "w:document");
  const body = docEl && firstChild(docEl, "w:body");
  if (!body) return report;

  report.trackedChanges = acceptTrackedChanges(docEl!);
  report.comments = findAll(docEl!, "w:commentReference").length > 0 || findAll(docEl!, "w:commentRangeStart").length > 0;

  // Top level: Word's own contents list goes; other content controls
  // are opened up so their paragraphs are seen.
  let tocLines = 0;
  const flat: XNode[] = [];
  for (const c of body.children) {
    if (c.kind === "el" && c.name === "w:sdt") {
      if (isTocBlock(c)) {
        tocLines += findAll(c, "w:p").length;
        continue;
      }
      const content = firstChild(c, "w:sdtContent");
      if (content) {
        flat.push(...content.children);
        continue;
      }
    }
    flat.push(c);
  }

  const blocks: Block[] = [];
  const blockNodes: XElem[] = [];
  let paraIndex = 0;
  for (const c of flat) {
    if (c.kind !== "el" || c.name === "w:sectPr") continue;
    if (c.name === "w:p") blocks.push({ kind: "p", f: readParagraph(c, sheet), index: paraIndex++ });
    else blocks.push({ kind: "other" });
    blockNodes.push(c);
  }

  const structure = planStructure(blocks, {
    makeChapter: options.makeChapter,
    notChapter: options.notChapter,
    keepLines: options.keepLines,
    keepContents: options.keepContents,
    keepTitleApart: options.keepTitleApart,
    sceneBreak: options.sceneBreak,
    noSceneBreak: options.noSceneBreak,
    notSubheading: options.notSubheading,
    notVerse: options.notVerse,
    keepCopyright: options.keepCopyright,
    removeTitlePage: options.removeTitlePage,
  });
  const { plans } = structure;

  // Word's automatic numbers, counted in document order like Word does.
  const labels = new Map<number, string>();
  blocks.forEach((b, j) => {
    if (b.kind !== "p" || !b.f.num) return;
    const label = nextNumberLabel(numbering, b.f.num.numId, b.f.num.ilvl);
    if (label && plans.get(j)?.numberLabel) labels.set(j, label);
  });

  const fixQuotes = options.fixQuotes !== false;
  const texts = blocks.flatMap((b, j) => (b.kind === "p" && !plans.get(j)?.remove ? [b.f.trimmed] : []));
  const quoteStyle = detectQuoteStyle(texts.join("\n"));
  const dialogueDash = detectDialogueDash(texts);
  const counts = emptyTidyCounts();

  // Per-paragraph edits.
  blocks.forEach((b, j) => {
    if (b.kind !== "p") return;
    const p = plans.get(j);
    if (p?.remove) return;
    const node = blockNodes[j];
    if (stripLeadingWhitespace(node)) report.fixes.indentsRemoved++;
    stripTrailingWhitespace(node);
    if (fixQuotes) transformText(node, (t) => tidyText(t, { quoteStyle, dialogueDash }, counts));
  });

  blocks.forEach((b, j) => {
    if (b.kind !== "p") return;
    const p = plans.get(j);
    if (!p || p.remove) return;
    const node = blockNodes[j];
    if (p.dropCapInto !== undefined) {
      insertAtStart(blockNodes[p.dropCapInto], contentNodes(node));
      report.fixes.dropCapsJoined++;
    }
    for (const k of p.mergeNextInto ?? []) {
      appendNodes(node, [lineBreakRun(), ...contentNodes(blockNodes[k])]);
    }
    const label = labels.get(j);
    if (label) {
      insertAtStart(node, [textRun(`${label} `)]);
      report.fixes.headingNumbersAdded++;
    }
    if (p.style) {
      setParagraphStyle(node, LIBRUM_STYLES[p.style].id);
      if (b.f.num) removeNumbering(node);
    } else if (label) {
      removeNumbering(node);
    }
  });

  // Audit N1: the author's own bookmarks with Librum's mark names would
  // fake a mark in the preview; they are dropped from the marked copy
  // (the ebook never keeps any of these names either way).
  const ownMarkIds = new Set<string>();
  const markNameRe = new RegExp(`^(?:${PARAGRAPH_MARK_PREFIX}|${SCENE_BREAK_MARK_PREFIX})`);
  const isOwnMark = (c: XNode) =>
    c.kind === "el" &&
    ((c.name === "w:bookmarkStart" && markNameRe.test(getAttr(c, "w:name") ?? "")) ||
      (c.name === "w:bookmarkEnd" && ownMarkIds.has(getAttr(c, "w:id") ?? "")));
  if (options.markParagraphs) {
    for (const c of flat) {
      if (c.kind !== "el") continue;
      if (c.name === "w:bookmarkStart" && markNameRe.test(getAttr(c, "w:name") ?? "")) ownMarkIds.add(getAttr(c, "w:id") ?? "");
      walk(c, (e) => {
        if (e.name === "w:bookmarkStart" && markNameRe.test(getAttr(e, "w:name") ?? "")) ownMarkIds.add(getAttr(e, "w:id") ?? "");
      });
    }
    if (ownMarkIds.size > 0) {
      for (const c of flat) {
        if (c.kind !== "el") continue;
        walk(c, (e) => {
          e.children = e.children.filter((x) => !isOwnMark(x));
        });
        c.children = c.children.filter((x) => !isOwnMark(x));
      }
    }
  }
  let markId = 0;
  const mark = (node: XElem, name: string) => {
    if (!options.markParagraphs) return;
    // Ids far above Word's own bookmark ids; Mammoth uses only the name.
    const id = 900_000_000 + markId++;
    insertAtStart(node, [
      el("w:bookmarkStart", ` w:id="${id}" w:name="${name}"`),
      el("w:bookmarkEnd", ` w:id="${id}"`),
    ]);
  };
  const out: XNode[] = [];
  let bi = 0;
  for (const c of flat) {
    if (c.kind !== "el" || c.name === "w:sectPr") {
      out.push(c);
      continue;
    }
    const j = bi++;
    // A top-level bookmark of the author's with a mark name (N1).
    if (ownMarkIds.size > 0 && isOwnMark(c)) continue;
    const p = plans.get(j);
    if (p?.remove || p?.mergedAway) continue;
    const b = blocks[j];
    const index = b.kind === "p" ? b.index : -1;
    if (p?.replaceWithSceneBreak) {
      out.push(sceneBreakParagraph());
      continue;
    }
    if (p?.sceneBreakBefore) {
      const sb = sceneBreakParagraph();
      mark(sb, `${SCENE_BREAK_MARK_PREFIX}${index}`);
      out.push(sb);
    }
    if (p?.gapBefore) out.push(gapParagraph());
    if (p?.splitAtBreaks) {
      let first = true;
      for (const part of splitAtLineBreaks(c)) {
        stripLeadingWhitespace(part);
        stripTrailingWhitespace(part);
        if (readParagraph(part, sheet).empty) continue;
        if (first) mark(part, `${PARAGRAPH_MARK_PREFIX}${index}`);
        first = false;
        out.push(part);
      }
      continue;
    }
    if (c.name === "w:p" && index >= 0) mark(c, `${PARAGRAPH_MARK_PREFIX}${index}`);
    out.push(c);
  }
  body.children = out;

  zip.file("word/document.xml", serializeXml(root));
  zip.file("word/styles.xml", addLibrumStyles(stylesXml));
  if (!stylesXml) await registerStylesPart(zip);

  report.applied = true;
  report.chapterSource = structure.chapterSource;
  report.chapters = structure.chapters;
  report.subheadings = structure.subheadings;
  report.sceneBreaks = structure.sceneBreaks;
  report.gaps = structure.gaps;
  report.quoteStyle = fixQuotes ? quoteStyle : "off";
  report.fixes.emptyLinesRemoved = structure.emptyRemoved;
  report.fixes.paragraphsSplit = structure.paragraphsSplit;
  report.fixes.contentsLinesRemoved = structure.contentsLinesRemoved + tocLines;
  report.fixes.frontLinesRemoved = structure.frontLinesRemoved;
  report.fixes.quotes = counts.quotes;
  report.fixes.apostrophes = counts.apostrophes;
  report.fixes.ellipses = counts.ellipses;
  report.fixes.dashes = counts.dashes;
  report.guesses = structure.guesses;
  return report;
}

// A .docx without styles.xml: add the new part to the package so
// Mammoth finds it.
async function registerStylesPart(zip: JSZip) {
  const ct = await readPart(zip, "[Content_Types].xml");
  if (ct && !ct.includes('PartName="/word/styles.xml"')) {
    zip.file(
      "[Content_Types].xml",
      ct.replace(
        /<\/Types>\s*$/,
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
      ),
    );
  }
  const relsPath = "word/_rels/document.xml.rels";
  const rels = await readPart(zip, relsPath);
  const rel = `<Relationship Id="rIdLibrumStyles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;
  if (!rels) {
    zip.file(
      relsPath,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel}</Relationships>`,
    );
  } else if (!/relationships\/styles"/.test(rels)) {
    zip.file(relsPath, rels.replace(/<\/Relationships>\s*$/, `${rel}</Relationships>`));
  }
}
