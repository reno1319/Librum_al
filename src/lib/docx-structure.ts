import { isLeaderLine, stripLeaderTail } from "@/lib/docx-leader";
import type { ParaFacts } from "@/lib/docx-paragraphs";
import type { LibrumStyleKey } from "@/lib/docx-styles";
import { hasOutsideMention } from "@/lib/outside-mentions";

// W3: decides the book's structure from how each paragraph LOOKS, for
// Word files where the author didn't use Heading styles (Renato's
// answers 2a, 4a, 5a, 9a, 31 Oct):
// - a line becomes a chapter only when 2+ strong signs agree (new page
//   or a gap of empty lines, centered, bigger font, bold, capitals,
//   "Kapitulli 3"-style words, a bare number); weaker guesses are kept
//   as normal text and reported, so the author preview (W4) can offer
//   them;
// - empty lines between two ordinary paragraphs are a scene break only
//   when the book rarely uses empty lines; never next to titles, poems
//   or centered lines;
// - typed "***" / "#" markers become the same centered "* * *";
// - a label line and its title line ("Kapitulli 1" + "Mëngjesi") make
//   one chapter.
// Pure: reads ParaFacts, returns a plan. docx-cleanup.ts applies it.

export type Confidence = "high" | "medium";

export type GuessKind =
  | "chapter"
  | "subheading"
  | "scene_break"
  | "title_page"
  | "copyright_page"
  | "typed_contents"
  | "verse"
  | "split_lines"
  | "merged_title";

export type CleanupGuess = {
  // Index of the Word paragraph (counting every top-level paragraph of
  // the original file from 0) -- stable for the same file, so the
  // preview can send it back as an override.
  paragraph: number;
  kind: GuessKind;
  text: string;
  confidence: Confidence;
  applied: boolean;
  signs: string[];
};

export type Block = { kind: "p"; f: ParaFacts; index: number } | { kind: "other" };

export type ParaPlan = {
  remove?: boolean;
  style?: LibrumStyleKey;
  sceneBreakBefore?: boolean;
  replaceWithSceneBreak?: boolean;
  mergeNextInto?: number[]; // block positions of the paragraphs merged into this one (title lines)
  mergedAway?: boolean;
  dropCapInto?: number; // block position this drop cap is glued to
  numberLabel?: boolean;
  splitAtBreaks?: boolean;
  // W3 Part 2: one blank line before this paragraph (answer 4a).
  gapBefore?: boolean;
};

export type StructureOptions = {
  makeChapter?: number[];
  notChapter?: number[];
  // Paragraphs typed with Shift+Enter that the author wants kept as one
  // paragraph (undo of a "split_lines" guess in the preview).
  keepLines?: number[];
  // Typed contents lists the author wants kept (undo of a
  // "typed_contents" guess; its paragraph number).
  keepContents?: number[];
  // Chapter labels the author wants kept apart from the line after them
  // (undo of a "merged_title" guess; the label's paragraph number).
  keepTitleApart?: number[];
  // W4 preview: single-empty-line suggestions the author accepts, and
  // scene breaks the author takes out (the paragraph after the gap).
  sceneBreak?: number[];
  noSceneBreak?: number[];
  // W4 preview: sub-headings and poems the author turns back into
  // normal text (the guess's paragraph number).
  notSubheading?: number[];
  notVerse?: number[];
  // BD3 patch 2 (answer 1a): a removed copyright page the author brings
  // back, and a typed title page the author chooses to remove (the
  // guess's paragraph number).
  keepCopyright?: number[];
  removeTitlePage?: number[];
};

export type StructureResult = {
  plans: Map<number, ParaPlan>; // block position -> plan
  guesses: CleanupGuess[];
  chapterSource: "styles" | "detected" | "none";
  chapters: number;
  subheadings: number;
  sceneBreaks: number;
  contentsLinesRemoved: number;
  // BD3 patch 2: lines of the author's copyright page and typed title page.
  frontLinesRemoved: number;
  emptyRemoved: number;
  paragraphsSplit: number;
  gaps: number;
};

const CHAPTER_WORD_RE =
  /^(kapitull(?:i)?|kreu|pjesa|pjes[ëe]|libri|tregimi|episodi|prologu|prolog|epilogu|epilog|parath[ëe]nie|pasth[ëe]nie|hyrje|chapter|part|book|prologue|epilogue)\b/i;
const NUMBER_LABEL_RE = /^(?:[IVXLCDM]{1,7}|\d{1,3})[.)]?$/;
const NUMBER_START_RE = /^(?:[IVXLCDM]{1,7}|\d{1,3})[.)]?\s+\S/;
const ORDINAL_WORDS = "(?:i|e)?\\s*(?:par[ëe]|dyt[ëe]|tret[ëe]|kat[ëe]rt[ëe]|pest[ëe]|gjasht[ëe]|shtat[ëe]|tet[ëe]|n[ëe]nt[ëe]|dhjet[ëe])";
const LABEL_ONLY_RE = new RegExp(
  `^(?:(?:kapitull(?:i)?|kreu|pjesa|libri|tregimi|chapter|part|book)\\s+(?:[IVXLCDM]{1,7}|\\d{1,3}|${ORDINAL_WORDS})[.:]?|(?:[IVXLCDM]{1,7}|\\d{1,3})[.)]?)$`,
  "i",
);
const SENTENCE_END_RE = /[.,;:…]["”»’)]*$/;
const CONTENTS_TITLE_RE =
  /^(?:p[ëe]rmbajtja|p[ëe]rmbajtje|pasqyra(?: e l[ëe]nd[ëe]s)?|tabela e p[ëe]rmbajtjes|l[ëe]nda|treguesi|contents|table of contents)\s*:?$/i;
const MARKER_RE = /^[\s*#⁂~•·✦❖◆◇§]{1,20}$/;
const MARKER_SYMBOL_RE = /[*#⁂~•·✦❖◆◇§]/;
const DIALOGUE_RE = /^[—–-][  ]/;
const NOT_A_TITLE_RE = /©|\bISBN\b|\bcopyright\b|t[ëe] gjitha t[ëe] drejtat/i;
// BD3 patch 2: lines of an author's own copyright page. Only lines a
// copyright page has are matched, never a phrase that a story can use
// ("të gjitha të drejtat e njeriut", "copyright-i i këngës"): audit r1
// H1-H3. JavaScript's \b treats "ë" as a non-letter, so the end of a
// word is (?![\p{L}\d]) with the u flag (audit r1 M2).
const END = String.raw`(?![\p{L}\d])`;
const COPYRIGHT_RE = new RegExp(
  [
    String.raw`©`,
    String.raw`\(c\)\s*(?:1[89]|20)\d{2}`,
    String.raw`\bcopyright[\s,:]*(?:©|\(c\)|(?:1[89]|20)\d{2}|by${END}|nga${END})`,
    String.raw`\bcopyrighted (?:property|material|work)`,
    String.raw`t[ëe] gjitha t[ëe] drejtat (?:(?:jan[ëe] )?t[ëe] |(?:jan[ëe] )?e )?rezervuara`,
    String.raw`t[ëe] drejtat e (?:botimit|autorit) (?:jan[ëe]|i p[ëe]rkasin|t[ëe] rezervuara|e rezervuara|mbrohen)`,
    String.raw`all rights reserved`,
    String.raw`\bISBN(?:-1[03])?[:\s]*(?:97[89][\s-]?)?\d[\d\s-]{7,}[\dXx]`,
    String.raw`\blicen[cs]e notes?${END}`,
    String.raw`\blicensed for your personal`,
    String.raw`may not be (?:reproduced|copied|re-?sold)`,
    String.raw`ndalohet (?:çdo |rreptësisht )?(?:riprodhim|kopjim|shumëfishim)`,
    String.raw`(?:riprodhimi|kopjimi|shumëfishimi)\b[^.]{0,60}\bndalohet`,
  ].join("|"),
  "iu",
);
const FRONT_META_RE = new RegExp(
  [
    String.raw`\bbotuar (?:nga|n[ëe])${END}`,
    String.raw`\bbotimi i${END}`,
    String.raw`\bbotim(?:i)? (?:i )?(?:par[ëe]|dyt[ëe]|tret[ëe]|elektronik|digjital)${END}`,
    String.raw`\bsht[ëe]pia botuese${END}`,
    String.raw`\bbotues(?:i)?${END}`,
    String.raw`\bpublished by${END}`,
    String.raw`\bfirst published${END}`,
    String.raw`\bindependently published${END}`,
    String.raw`\b(?:smashwords |kindle |first |second |\d+(?:st|nd|rd|th) )?edition${END}`,
    String.raw`\bredakt(?:or|ore|imi|uar)${END}`,
    String.raw`\bkorrektur|\bkorrektor`,
    String.raw`\bkopertin`,
    String.raw`\bcover (?:design|art|image|by)${END}`,
    String.raw`\bprinted in${END}`,
    String.raw`\bshtypur n[ëe]${END}`,
    String.raw`^\s*(?:1[89]|20)\d{2}\s*$`,
    String.raw`www\.`,
    String.raw`https?:\/\/`,
  ].join("|"),
  "iu",
);
// A line that ends like a sentence or a question (audit r1 H1). A
// label ending in ":" ("Na gjeni në:") or a list line ending in "," is
// not a sentence.
const SENTENCE_LIKE_END_RE = /[.;…?!]["”»’)]*$/u;
const DIALOGUE_START_RE = /^[—–-]/u;
// A part or chapter heading ("PART ONE", "Pjesa e parë: Deti",
// "Kapitulli 1") is never a book title; "Libri i detit" can be (audit
// r3 M1): the number or ordinal must end the line or come before ":".
const PART_HEADING_RE = new RegExp(
  String.raw`^(?:kapitull(?:i)?|chapter|pjesa|pjes[ëe]|part|book|libri|kreu)\s+` +
    String.raw`(?:[IVXLCDM]{1,7}|\d{1,3}|one|two|three|four|five|first|second|third|[ie]\s+(?:par[ëe]|dyt[ëe]|tret[ëe]|kat[ëe]rt[ëe]|pest[ëe]))` +
    String.raw`\s*(?:$|[:.\-–—])`,
  "iu",
);
// A dedication never counts as a book title (audit r3 H1, M1).
const DEDICATION_START_RE = /^(?:p[ëe]r|for|to|kushtuar|dedikuar|in memoriam|n[ëe] kujtim)(?![\p{L}\d])/iu;
const MAX_FRONT_PARAS = 60;
const MAX_COPYRIGHT_PARA_WORDS = 90;
const MAX_META_LINE_WORDS = 8;
const MAX_TITLE_LINE_WORDS = 12;

const ROMAN: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1000 };
function trailingPageNumber(t: string): { value: number; roman: boolean } | null {
  const m = t.match(/(\d{1,4}|[ivxlcdm]{1,6})$/i);
  if (!m) return null;
  if (/^\d/.test(m[1])) return { value: Number(m[1]), roman: false };
  let total = 0;
  const r = m[1].toLowerCase();
  for (let i = 0; i < r.length; i++) {
    const v = ROMAN[r[i]];
    total += i + 1 < r.length && ROMAN[r[i + 1]] > v ? -v : v;
  }
  return { value: total, roman: true };
}

function words(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

function truncate(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat;
}

function weightedMedian(values: [number, number][]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((s, [, w]) => s + w, 0);
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return sorted[sorted.length - 1][0];
}

export function planStructure(blocks: Block[], options: StructureOptions = {}): StructureResult {
  const plans = new Map<number, ParaPlan>();
  const plan = (j: number): ParaPlan => {
    let p = plans.get(j);
    if (!p) {
      p = {};
      plans.set(j, p);
    }
    return p;
  };
  const guesses: CleanupGuess[] = [];
  const chapterGuessAt = (paragraph: number) =>
    guesses.find((x) => x.paragraph === paragraph && (x.kind === "chapter" || x.kind === "subheading"));
  const para = (j: number): ParaFacts | null => (blocks[j]?.kind === "p" ? (blocks[j] as { f: ParaFacts }).f : null);
  const indexOf = (j: number): number => (blocks[j] as { index: number }).index;
  const isRemoved = (j: number) => plans.get(j)?.remove === true || plans.get(j)?.mergedAway === true;

  // ---- 1. typed contents lists ----
  let contentsLinesRemoved = 0;
  const isTocStyle = (f: ParaFacts) => /^toc ?\d|^table of figures$/i.test(f.styleName.trim());
  // A line of a contents list: dots/tab + page number, or (Word's own
  // list with page numbers off) a link to a "_Toc" bookmark.
  const isContentsLine = (f: ParaFacts) => isLeaderLine(f.trimmed) || f.tocLink || isTocStyle(f);
  const isContentsTitle = (f: ParaFacts) => CONTENTS_TITLE_RE.test(f.trimmed) || /^toc heading$/i.test(f.styleName.trim());
  for (let j = 0; j < blocks.length; j++) {
    const f = para(j);
    if (f && !f.empty && isTocStyle(f)) {
      plan(j).remove = true;
      contentsLinesRemoved++;
    }
  }
  // Hand-typed: 3+ lines ending in a page number after dots/tabs (empty
  // lines between are fine), or 2+ right after a "Përmbajtja" title.
  // A recipe, a timetable or a price list looks the same (audits R1,
  // F1, F2), and losing the author's text is worse than keeping a stray
  // contents list (the author can delete it in the preview). So such a
  // list is only collected here and decided after the chapters are
  // known: it is removed only when its numbers never go down AND most
  // of its lines, without the page number, are the titles of chapters
  // actually found (Heading styles or the hand-typed detection).
  // Everything else is kept and reported as an unsure guess; the author
  // can also bring back a removed list (keepContents). Lines linking to
  // Word's own "_Toc" bookmarks are always a contents list.
  const keepContentsSet = new Set(options.keepContents ?? []);
  type TypedList = { run: number[]; titleAt: number; ascending: boolean };
  const typedLists: TypedList[] = [];
  const typedListParas = new Set<number>(); // not chapter candidates while undecided
  for (let j = 0; j < blocks.length; j++) {
    const f = para(j);
    if (!f || f.empty || isRemoved(j) || !isContentsLine(f)) continue;
    const run: number[] = [];
    let k = j;
    while (k < blocks.length) {
      const g = para(k);
      if (!g) break;
      if (g.empty) {
        k++;
        continue;
      }
      if (!isContentsLine(g)) break;
      run.push(k);
      k++;
    }
    let titleAt = -1;
    for (let b = j - 1; b >= 0; b--) {
      const g = para(b);
      if (!g) break;
      if (g.empty) continue;
      if (isContentsTitle(g)) titleAt = b;
      break;
    }
    j = k - 1;
    if (!(run.length >= 3 || (run.length >= 2 && titleAt >= 0))) continue;
    const kept = keepContentsSet.has(indexOf(run[0]));
    if (run.every((r) => para(r)!.tocLink || isTocStyle(para(r)!))) {
      if (!kept) {
        for (const r of run) {
          if (!plan(r).remove) contentsLinesRemoved++;
          plan(r).remove = true;
        }
      }
      guesses.push({
        paragraph: indexOf(run[0]),
        kind: "typed_contents",
        text: truncate(para(run[0])!.trimmed),
        confidence: "high",
        applied: !kept,
        signs: ["links to Word's contents bookmarks", ...(kept ? ["kept by the author"] : [])],
      });
      continue;
    }
    const pages = run.map((r) => trailingPageNumber(para(r)!.trimmed)).filter((x) => x !== null);
    // Front matter may be numbered i, ii, iii before the body's 1, 2, 3.
    const ascending = pages.every(
      (x, i) => i === 0 || (x.roman === pages[i - 1].roman ? x.value >= pages[i - 1].value : !x.roman),
    );
    typedLists.push({ run, titleAt, ascending });
    for (const r of run) typedListParas.add(r);
    if (titleAt >= 0) typedListParas.add(titleAt);
  }
  // The "Përmbajtja" title over a removed list goes too.
  for (let j = 0; j < blocks.length; j++) {
    const f = para(j);
    if (!f || f.empty || isRemoved(j) || !isContentsTitle(f)) continue;
    let k = j + 1;
    while (k < blocks.length && para(k)?.empty) k++;
    if (k < blocks.length && plans.get(k)?.remove && para(k) && !para(k)!.empty) {
      plan(j).remove = true;
      contentsLinesRemoved++;
    }
  }

  // ---- 2. layout facts per block ----
  const n = blocks.length;
  const newPage: boolean[] = new Array(n).fill(false);
  const emptiesBefore: number[] = new Array(n).fill(0);
  {
    let pendingBreak = false;
    let empties = 0;
    let seenContent = false;
    for (let j = 0; j < n; j++) {
      const f = para(j);
      if (f && (f.empty || isRemoved(j))) {
        if (f.breakBefore || f.breakAfter) pendingBreak = true;
        if (f.empty) empties++;
        continue;
      }
      newPage[j] = seenContent && (pendingBreak || (f?.breakBefore ?? false));
      emptiesBefore[j] = seenContent ? empties : 0;
      pendingBreak = f?.breakAfter ?? false;
      empties = 0;
      seenContent = true;
    }
  }
  const nextContent = (j: number, maxEmpties = Infinity): number => {
    let empties = 0;
    for (let k = j + 1; k < n; k++) {
      const f = para(k);
      if (f && isRemoved(k)) continue;
      if (f && f.empty) {
        if (++empties > maxEmpties) return -1;
        continue;
      }
      return k;
    }
    return -1;
  };

  const textParas: number[] = [];
  for (let j = 0; j < n; j++) {
    const f = para(j);
    if (f && !f.empty && !isRemoved(j) && !f.hasObject) textParas.push(j);
  }
  const median =
    weightedMedian(textParas.map((j) => [para(j)!.size ?? 24, Math.max(1, para(j)!.trimmed.length)])) ?? 24;
  const bigger = (f: ParaFacts) => (f.size ?? median) >= median + 2;
  const centered = (f: ParaFacts) => f.align === "center";

  // ---- 3. typed scene-break markers and drop caps ----
  for (const j of textParas) {
    const f = para(j)!;
    if (f.headingLevel || !MARKER_RE.test(f.trimmed) || !MARKER_SYMBOL_RE.test(f.trimmed)) continue;
    plan(j).replaceWithSceneBreak = true;
  }
  for (const j of textParas) {
    const f = para(j)!;
    if (!f.dropCap || f.trimmed.length > 3) continue;
    const k = nextContent(j, 0);
    if (k >= 0 && para(k)) {
      plan(j).dropCapInto = k;
      plan(j).mergedAway = true;
    }
  }

  // ---- 4. chapters ----
  const styledH1 = textParas.filter((j) => para(j)!.headingLevel === 1);
  const styledH2 = textParas.filter((j) => para(j)!.headingLevel === 2);
  let chapterSource: StructureResult["chapterSource"] = "none";
  const chapterSet = new Set<number>();
  const subSet = new Set<number>();
  const makeSet = new Set(options.makeChapter ?? []);
  const notSet = new Set(options.notChapter ?? []);

  const candidate = (j: number) => {
    const f = para(j)!;
    if (plans.get(j)?.replaceWithSceneBreak || plans.get(j)?.mergedAway) return false;
    if (typedListParas.has(j)) return false;
    if (f.num && !f.headingLevel) return false;
    const t = f.trimmed;
    if (t.length === 0 || t.length > 90 || words(t) > 14 || f.lineBreaks > 1) return false;
    if (NOT_A_TITLE_RE.test(t) || DIALOGUE_RE.test(t) || /^[([]/.test(t)) return false;
    if (SENTENCE_END_RE.test(t) && !LABEL_ONLY_RE.test(t) && !NUMBER_START_RE.test(t)) return false;
    return true;
  };

  if (styledH1.length > 0) {
    chapterSource = "styles";
    for (const j of styledH1) chapterSet.add(j);
  } else if (styledH2.length >= 2) {
    // No Heading 1 but several Heading 2 (e.g. a poetry book with each
    // poem title as Heading 2): those are the chapters.
    chapterSource = "styles";
    for (const j of styledH2) {
      chapterSet.add(j);
      plan(j).style = "chapter";
      guesses.push({
        paragraph: indexOf(j),
        kind: "chapter",
        text: truncate(para(j)!.trimmed),
        confidence: "high",
        applied: true,
        signs: ["heading 2 style, no heading 1 in the book"],
      });
    }
  } else {
    // The first page, when it is a typed title page (a few centered or
    // big lines), never holds chapters.
    const firstPageEnd = textParas.find((j) => newPage[j]) ?? -1;
    const firstPage = firstPageEnd >= 0 ? textParas.filter((j) => j < firstPageEnd) : [];
    const titleLike = firstPage.filter((j) => centered(para(j)!) || bigger(para(j)!) || /^title$/i.test(para(j)!.styleName));
    const firstPageIsTitle = firstPage.length > 0 && firstPage.length <= 12 && titleLike.length / firstPage.length >= 0.6;

    type Signs = { pos: boolean; keyword: boolean; number: boolean; center: boolean; big: boolean; bold: boolean; caps: boolean };
    const signsOf = new Map<number, Signs>();
    const sigCount = new Map<string, number>(); // candidates with a position or label sign
    const lookCount = new Map<string, number>(); // candidates with any sign
    // Titles typed by hand repeat one look: the same size, alignment,
    // bold, capitals and italics.
    const sigKey = (f: ParaFacts) => `${f.size ?? median}|${centered(f)}|${f.bold}|${f.caps}|${f.italic}`;
    for (const j of textParas) {
      if (!candidate(j)) continue;
      if (firstPageIsTitle && j < firstPageEnd) continue;
      const f = para(j)!;
      const s: Signs = {
        pos: newPage[j] || emptiesBefore[j] >= 2,
        keyword: CHAPTER_WORD_RE.test(f.trimmed),
        number: NUMBER_LABEL_RE.test(f.trimmed) || NUMBER_START_RE.test(f.trimmed),
        center: centered(f),
        big: bigger(f),
        bold: f.bold,
        caps: f.caps,
      };
      signsOf.set(j, s);
      const key = sigKey(f);
      if (s.pos || s.keyword || s.number) sigCount.set(key, (sigCount.get(key) ?? 0) + 1);
      if (s.pos || s.keyword || s.number || s.center || s.big || s.bold || s.caps) lookCount.set(key, (lookCount.get(key) ?? 0) + 1);
    }

    for (const [j, s] of signsOf) {
      const f = para(j)!;
      const look = Number(s.center) + Number(s.big) + Number(s.bold) + Number(s.caps);
      const shared = (sigCount.get(sigKey(f)) ?? 0) >= 2;
      // Part of a block of similar short lines (a poem, an epigraph,
      // a title page): not a title unless it stands out.
      const k = nextContent(j, 1);
      const g = k >= 0 ? para(k) : null;
      const blockGuard =
        !!g && candidate(k) && centered(g) === s.center && (g.size ?? median) >= (f.size ?? median) && !LABEL_ONLY_RE.test(f.trimmed);
      const signList = [
        newPage[j] ? "new page" : "",
        emptiesBefore[j] >= 2 ? "empty lines before" : "",
        s.keyword ? "chapter word" : "",
        s.number ? "number" : "",
        s.center ? "centered" : "",
        s.big ? "bigger font" : "",
        s.bold ? "bold" : "",
        s.caps ? "capitals" : "",
      ].filter(Boolean);

      let level: Confidence | null = null;
      if (s.keyword && (s.pos || look >= 1)) level = "high";
      else if (s.number && s.pos && (LABEL_ONLY_RE.test(f.trimmed) || look >= 1)) level = "high";
      else if (s.pos && look >= 1 && (shared || s.big) && !blockGuard) level = "high";
      else if (!s.pos && s.big && look >= 2 && (lookCount.get(sigKey(f)) ?? 0) >= 2 && !blockGuard) level = "high";
      else if (s.pos || ((s.bold || s.caps || s.big) && words(f.trimmed) <= 8)) level = "medium";
      if (level === "high" && f.italic && !s.big && !s.keyword) level = "medium";
      if (level === "high" && blockGuard && !s.keyword && !s.number) level = "medium";

      if (level === "high") chapterSet.add(j);
      if (level) {
        guesses.push({
          paragraph: indexOf(j),
          kind: "chapter",
          text: truncate(f.trimmed),
          confidence: level,
          applied: level === "high",
          signs: signList,
        });
      }
    }
    // A bare "I." found only by the empty lines before it is a section
    // inside a story (a novella's "I." / "II."), unless the book's real
    // chapter titles look the same (bold, big "3." among "Kapitulli 2").
    const wordChapterKeys = new Set(
      [...chapterSet].filter((j) => !NUMBER_LABEL_RE.test(para(j)!.trimmed)).map((j) => sigKey(para(j)!)),
    );
    for (const j of [...chapterSet]) {
      const f = para(j)!;
      if (!NUMBER_LABEL_RE.test(f.trimmed) || newPage[j] || wordChapterKeys.has(sigKey(f))) continue;
      if (wordChapterKeys.size === 0) continue;
      chapterSet.delete(j);
      const g = chapterGuessAt(indexOf(j));
      if (g) {
        g.kind = "subheading";
        g.signs.push("looks unlike the chapter titles");
      }
      subSet.add(j);
    }
    if (chapterSet.size > 0 || makeSet.size > 0) chapterSource = "detected";

    // Sub-headings inside detected chapters: "I." or "II. Title" that is
    // centered, italic, bold or bigger, not on a new page; or a short
    // all-italic/all-bold line after an empty line that opens a normal
    // paragraph ("Mbi gjuhën").
    let firstChapterAt = Infinity;
    for (const j of chapterSet) firstChapterAt = Math.min(firstChapterAt, j);
    for (const j of textParas) {
      if (chapterSet.has(j) || subSet.has(j) || !candidate(j) || j < firstChapterAt) continue;
      const f = para(j)!;
      if (
        (f.italic || f.bold) && !centered(f) && f.align !== "right" && words(f.trimmed) <= 8 &&
        emptiesBefore[j] >= 1 && !newPage[j] && !SENTENCE_END_RE.test(f.trimmed) && !/[?!]$/.test(f.trimmed)
      ) {
        const k = nextContent(j, 1);
        const g = k >= 0 ? para(k) : null;
        if (g && !g.italic && !g.bold && g.trimmed.length >= 100 && !chapterSet.has(k)) {
          subSet.add(j);
          guesses.push({
            paragraph: indexOf(j),
            kind: "subheading",
            text: truncate(f.trimmed),
            confidence: "high",
            applied: true,
            signs: ["short line", f.italic ? "italic" : "bold", "empty line before", "followed by text"],
          });
          continue;
        }
      }
      if (!(NUMBER_LABEL_RE.test(f.trimmed) || NUMBER_START_RE.test(f.trimmed))) continue;
      if (!(centered(f) || f.italic || f.bold || bigger(f))) continue;
      if (chapterSet.size === 0) continue;
      subSet.add(j);
      guesses.push({
        paragraph: indexOf(j),
        kind: "subheading",
        text: truncate(f.trimmed),
        confidence: "high",
        applied: true,
        signs: ["number", centered(f) ? "centered" : f.italic ? "italic" : f.bold ? "bold" : "bigger font"],
      });
    }
  }

  // Author overrides from the preview (W4).
  const notSubSet = new Set(options.notSubheading ?? []);
  // Chapters the author says are not chapters (for their title lines,
  // below the title-line rules).
  const authorRemoved = new Set<number>();
  for (let j = 0; j < n; j++) {
    const f = para(j);
    if (!f || f.empty) continue;
    const idx = indexOf(j);
    if (notSubSet.has(idx) && subSet.has(j) && !makeSet.has(idx)) {
      subSet.delete(j);
      const g = chapterGuessAt(idx);
      if (g) {
        g.applied = false;
        g.signs.push("kept as normal text by the author");
      }
    }
    if (!makeSet.has(idx) && !notSet.has(idx)) continue;
    if (makeSet.has(idx) && !chapterSet.has(j)) {
      chapterSet.add(j);
      subSet.delete(j);
      plans.delete(j);
      chapterSource = chapterSource === "none" ? "detected" : chapterSource;
    }
    if (notSet.has(idx) && chapterSet.has(j)) {
      chapterSet.delete(j);
      authorRemoved.add(j);
      if (plans.get(j)?.style === "chapter") delete plan(j).style;
      // A line the author styled Heading 1 by mistake: Word's style
      // would still make it a chapter, so it is set as plain text.
      if (f.headingLevel === 1) plan(j).style = "plain";
    }
    const g = chapterGuessAt(idx);
    if (g) {
      g.kind = "chapter";
      g.applied = chapterSet.has(j);
    }
  }
  // "Kapitulli 1" + its title line -> one heading (answer 9a). Merged only
  // when the next line genuinely looks like a title, and when in doubt
  // not (audits F3, F4, F5):
  //   - the label is a bare label ("Kapitulli 1", "KREU IV", "II.");
  //   - the title comes after at most 3 empty lines, on the same page,
  //     with the label's alignment (unless the label is Heading-styled);
  //   - it is a short line that doesn't end like a sentence and isn't a
  //     label, chapter word or number itself;
  //   - it looks like a heading: bigger, bold or capitals, or the same
  //     Heading style as the label (a centered line in the body's font
  //     after "II" is a poem's first line, not its title). A plain label
  //     followed by a Heading-styled line is a separate heading; a
  //     Heading-styled label with a typed title is merged (audit H2);
  //   - it doesn't open a block of 3+ similar short lines (a poem);
  //   - a second line in exactly the same look right after it, which
  //     detection also took for a chapter, is the title's second line
  //     (a long title broken by hand, audit H1b);
  //   - the author didn't keep them apart in the preview.
  // Every merge is reported, so the preview can undo it (keepTitleApart).
  // A last safety net (below the merge) joins a chapter that is only a
  // label and has nothing in it to the next chapter's title.
  const keepApartSet = new Set(options.keepTitleApart ?? []);
  const sameLook = (a: ParaFacts, b: ParaFacts) =>
    centered(a) === centered(b) && (a.size ?? median) === (b.size ?? median) && a.bold === b.bold && a.italic === b.italic && a.caps === b.caps;
  const shortSameLook = (g: ParaFacts, k: number) => {
    const h = k >= 0 && !newPage[k] ? para(k) : null;
    return !!h && !h.empty && h.trimmed.length <= 60 && !h.headingLevel && sameLook(g, h);
  };
  // Decided once per label: later steps take lines out of the chapter
  // list, which must not change the answer.
  const titleLinesMemo = new Map<number, number[]>();
  const titleLinesOf = (j: number): number[] => {
    let lines = titleLinesMemo.get(j);
    if (!lines) {
      lines = findTitleLines(j);
      titleLinesMemo.set(j, lines);
    }
    return lines;
  };
  const findTitleLines = (j: number): number[] => {
    const f = para(j)!;
    if (!LABEL_ONLY_RE.test(f.trimmed)) return [];
    const k = nextContent(j, 3);
    if (k < 0 || newPage[k] || subSet.has(k) || isRemoved(k) || makeSet.has(indexOf(k))) return [];
    const g = para(k);
    if (!g || !candidate(k) || g.num) return [];
    if (g.headingLevel && g.headingLevel !== f.headingLevel) return [];
    if (SENTENCE_END_RE.test(g.trimmed) && !/[?!]$/.test(g.trimmed)) return [];
    if (LABEL_ONLY_RE.test(g.trimmed) || CHAPTER_WORD_RE.test(g.trimmed) || NUMBER_LABEL_RE.test(g.trimmed)) return [];
    // A Heading-styled label takes its alignment from the style, so only
    // a typed label must match the title's alignment.
    if (!f.headingLevel && centered(g) !== centered(f)) return [];
    if (!((g.headingLevel && g.headingLevel === f.headingLevel) || bigger(g) || g.bold || g.caps)) return [];
    // Two more short lines in the same look: a poem, not a title.
    const k2 = nextContent(k, 1);
    if (shortSameLook(g, k2) && shortSameLook(g, nextContent(k2, 1))) return [];
    // The second line of a title broken by hand.
    const next = nextContent(k, 0);
    if (next >= 0 && chapterSet.has(next) && !makeSet.has(indexOf(next)) && shortSameLook(g, next) && candidate(next) &&
        !LABEL_ONLY_RE.test(para(next)!.trimmed) && !CHAPTER_WORD_RE.test(para(next)!.trimmed) && !NUMBER_LABEL_RE.test(para(next)!.trimmed)) {
      return [k, next];
    }
    return [k];
  };
  // A title line that detection also took for a chapter stops being one
  // here, so the label isn't left as an empty chapter.
  for (const j of [...chapterSet].sort((a, b) => a - b)) {
    if (!chapterSet.has(j) || keepApartSet.has(indexOf(j))) continue;
    for (const k of titleLinesOf(j)) {
      if (!chapterSet.has(k)) continue;
      chapterSet.delete(k);
      const guess = chapterGuessAt(indexOf(k));
      if (guess) {
        guess.applied = false;
        guess.signs.push("title line of the chapter label above");
      }
    }
  }
  // W4 (audit F1): "not a chapter" on "Kapitulli 2" whose title line
  // ("Kthimi") was joined to it removes the whole chapter: the title
  // line must not become the chapter instead. Same for a bare label
  // whose next line is a chapter on the same page with nothing between
  // (the safety net's case below).
  for (const j of [...authorRemoved].sort((a, b) => a - b)) {
    if (keepApartSet.has(indexOf(j))) continue;
    let lines = titleLinesOf(j);
    if (lines.length === 0 && LABEL_ONLY_RE.test(para(j)!.trimmed)) {
      const k = nextContent(j);
      const g = k >= 0 ? para(k) : null;
      if (g && chapterSet.has(k) && !newPage[k] && !LABEL_ONLY_RE.test(g.trimmed) && !CHAPTER_WORD_RE.test(g.trimmed) && !NUMBER_LABEL_RE.test(g.trimmed)) {
        lines = [k];
      }
    }
    for (const k of lines) {
      if (!chapterSet.has(k) || makeSet.has(indexOf(k))) continue;
      chapterSet.delete(k);
      if (para(k)!.headingLevel === 1) plan(k).style = "plain";
      const guess = chapterGuessAt(indexOf(k));
      if (guess) {
        guess.applied = false;
        guess.signs.push("title of a chapter the author says is not a chapter");
      }
    }
  }
  if (chapterSource === "detected" && chapterSet.size === 0) chapterSource = "none";

  // The titles of the chapters actually found, for recognising a typed
  // contents list: whole titles only, never a word or an ending.
  const norm = (t: string) => t.toLocaleLowerCase("sq").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  // "1. Mëngjesi" / "I. Mëngjesi" and "Mëngjesi" are the same title.
  const noNumber = (t: string) => t.replace(/^(?:[ivxlcdm]{1,7}|\d{1,3}) /, "");
  const titleForms = new Set<string>();
  const isChapterTitle = (text: string) => {
    const label = norm(text);
    return label !== "" && (titleForms.has(label) || titleForms.has(noNumber(label)));
  };
  // Typed lists with page numbers (collected in step 1): decide now.
  {
    const addTitle = (t: string) => {
      const n = norm(t);
      if ((n.match(/\p{L}/gu)?.length ?? 0) < 2) return;
      titleForms.add(n);
      titleForms.add(noNumber(n));
    };
    for (let j = 0; j < n; j++) {
      const f = para(j);
      if (!f || f.empty || isRemoved(j) || !(chapterSet.has(j) || f.headingLevel)) continue;
      addTitle(f.trimmed);
      // "Kapitulli 1" + "Mëngjesi" on the next line: the list may say
      // "Kapitulli 1: Mëngjesi" or just "Mëngjesi".
      const lines = titleLinesOf(j).map((k) => para(k)!.trimmed);
      if (lines.length > 0) {
        addTitle(`${f.trimmed} ${lines.join(" ")}`);
        addTitle(lines.join(" "));
      }
    }
    for (const list of typedLists) {
      const kept = keepContentsSet.has(indexOf(list.run[0]));
      const named = list.run.filter((r) => isChapterTitle(stripLeaderTail(para(r)!.trimmed))).length;
      const matches = named * 2 > list.run.length;
      const remove = !kept && matches && list.ascending;
      if (remove) {
        for (const r of list.run) {
          if (!plan(r).remove) contentsLinesRemoved++;
          plan(r).remove = true;
        }
        if (list.titleAt >= 0 && !isRemoved(list.titleAt)) {
          plan(list.titleAt).remove = true;
          contentsLinesRemoved++;
        }
      }
      guesses.push({
        paragraph: indexOf(list.run[0]),
        kind: "typed_contents",
        text: truncate(para(list.run[0])!.trimmed),
        confidence: remove || kept ? "high" : "medium",
        applied: remove,
        signs: [
          `${list.run.length} lines ending in page numbers`,
          `${named} of them are chapter titles`,
          ...(remove ? [] : [kept ? "kept by the author" : !matches ? "lines are not the chapter titles" : "numbers go down"]),
        ],
      });
    }
  }

  // A typed contents list without page numbers: lines under a
  // "Përmbajtja" title that repeat the chapter titles found later
  // (undo: keepContents with the title's paragraph number).
  {
    for (const j of textParas) {
      const f = para(j)!;
      if (isRemoved(j) || !isContentsTitle(f) || chapterSet.has(j)) continue;
      const run: number[] = [];
      let k = nextContent(j, 2);
      while (k >= 0 && para(k) && !chapterSet.has(k)) {
        const g = para(k)!;
        // Lines with page numbers were judged above; that verdict stands.
        if (isContentsLine(g)) break;
        if (!isChapterTitle(g.trimmed)) break;
        run.push(k);
        k = nextContent(k, 2);
      }
      if (run.length >= 2) {
        if (keepContentsSet.has(indexOf(j))) {
          guesses.push({
            paragraph: indexOf(j),
            kind: "typed_contents",
            text: truncate(f.trimmed),
            confidence: "high",
            applied: false,
            signs: [`${run.length} lines repeating the chapter titles`, "kept by the author"],
          });
          continue;
        }
        for (const r of [j, ...run]) {
          plan(r).remove = true;
          contentsLinesRemoved++;
          subSet.delete(r);
        }
        guesses.push({
          paragraph: indexOf(j),
          kind: "typed_contents",
          text: truncate(f.trimmed),
          confidence: "high",
          applied: true,
          signs: [`${run.length} lines repeating the chapter titles`],
        });
      }
    }
  }

  for (const j of chapterSet) {
    const f = para(j)!;
    if (f.headingLevel === 1) {
      if (f.num) plan(j).numberLabel = true;
      continue;
    }
    plan(j).style = "chapter";
    if (f.num) plan(j).numberLabel = true;
  }
  for (const j of subSet) plan(j).style = "subheading";
  for (const j of textParas) {
    const f = para(j)!;
    if (f.headingLevel && f.headingLevel > 1 && f.num && !chapterSet.has(j)) plan(j).numberLabel = true;
  }

  // "Kapitulli 1" + "Mëngjesi" on the next line -> one heading (rules
  // above titleLinesOf).
  const mergeTitle = (j: number, lines: number[], kept: boolean, sign: string) => {
    if (!kept) {
      plan(j).mergeNextInto = lines;
      for (const k of lines) plan(k).mergedAway = true;
    }
    guesses.push({
      paragraph: indexOf(j),
      kind: "merged_title",
      text: truncate(`${para(j)!.trimmed}: ${lines.map((k) => para(k)!.trimmed).join(" ")}`),
      confidence: "high",
      applied: !kept,
      signs: [sign, ...(kept ? ["kept apart by the author"] : [])],
    });
  };
  for (const j of [...chapterSet, ...subSet].sort((x, y) => x - y)) {
    const lines = titleLinesOf(j);
    if (lines.length === 0 || lines.some((k) => plans.get(k)?.mergedAway)) continue;
    const kept = keepApartSet.has(indexOf(j));
    if (!kept && lines.some((k) => chapterSet.has(k))) continue;
    mergeTitle(j, lines, kept, lines.length > 1 ? "chapter label with its title on the next two lines" : "chapter label with its title on the next line");
    // W4 audit A3: "keep apart" on a title typed on two lines keeps the
    // label as its own chapter and the two title lines together as the
    // next chapter (before, the first line became text of the label's
    // chapter and the second line a chapter of its own).
    if (kept && lines.length === 2 && chapterSet.has(j)) {
      const [a, b] = lines;
      chapterSet.add(a);
      chapterSet.delete(b);
      if (para(a)!.headingLevel !== 1) plan(a).style = "chapter";
      plan(a).mergeNextInto = [b];
      plan(b).mergedAway = true;
      const ga = chapterGuessAt(indexOf(a));
      if (ga) ga.applied = true;
      const gb = chapterGuessAt(indexOf(b));
      if (gb) gb.applied = false;
    }
  }
  // Safety net (audit H1a): a chapter that is only a label ("Kapitulli
  // 1") with nothing in it before the next chapter, on the same page,
  // takes that chapter's title. A label followed by a page break ("Pjesa
  // I" on its own page) stays alone: part pages stand alone.
  for (const j of [...chapterSet].sort((x, y) => x - y)) {
    const f = para(j)!;
    if (!chapterSet.has(j) || !LABEL_ONLY_RE.test(f.trimmed) || plans.get(j)?.mergeNextInto) continue;
    const k = nextContent(j);
    if (k < 0 || !chapterSet.has(k) || newPage[k] || makeSet.has(indexOf(k)) || plans.get(k)?.mergeNextInto) continue;
    const g = para(k);
    if (!g || LABEL_ONLY_RE.test(g.trimmed) || CHAPTER_WORD_RE.test(g.trimmed) || NUMBER_LABEL_RE.test(g.trimmed)) continue;
    const kept = keepApartSet.has(indexOf(j));
    if (!kept) {
      chapterSet.delete(k);
      const guess = chapterGuessAt(indexOf(k));
      if (guess) {
        guess.applied = false;
        guess.signs.push("title of the empty chapter label above");
      }
    }
    mergeTitle(j, [k], kept, "empty chapter label joined to the next title");
  }

  // ---- 5. front matter: the author's own copyright page and typed
  // title page (BD3 patch 2, Renato 1 Nov: 2a, and 1a 2a 3a) ----
  // Librum adds its own page with the title, the pen name and the
  // copyright line to every download, so the author's own copyright
  // lines go, and the big title lines of a typed title page go too.
  // Losing an author's real text is the worst outcome (audit r1), so
  // only lines of a known kind are removed and everything else on the
  // page stays (a dedication, an epigraph, an author's note, a list):
  // - copyright lines (COPYRIGHT_RE, at most 90 words);
  // - next to them, short publisher/edition/year/web/store/email lines
  //   that are not sentences (anywhere on a page that has a copyright
  //   line and ends with a page break; else only touching one);
  // - on the first page, closed by a page break, before a real first
  //   chapter: the lines bigger than every chapter title (or in Word's
  //   Title style), and a byline ("nga ...", "përktheu ...").
  // Only before the first chapter, plus the short lines right under the
  // title of a one-story book (its only chapter). The author can undo
  // copyright group in the preview (keepCopyright); a title page is only
  // offered for removal (removeTitlePage, Renato 1 Nov after audit r4).
  const firstChapter = textParas.find((j) => chapterSet.has(j));
  const keepCopyrightSet = new Set(options.keepCopyright ?? []);
  const removeTitlePageSet = new Set(options.removeTitlePage ?? []);
  let frontLinesRemoved = 0;
  {
    const text = (j: number) => para(j)!.trimmed;
    const sentenceLike = (j: number) => SENTENCE_LIKE_END_RE.test(text(j)) && words(text(j)) > 3;
    const copyrightLine = (j: number) => COPYRIGHT_RE.test(text(j)) && words(text(j)) <= MAX_COPYRIGHT_PARA_WORDS;
    // A sentence of more than 12 words: the story (or a preface) has begun.
    const storyLine = (j: number) => words(text(j)) > MAX_TITLE_LINE_WORDS && SENTENCE_LIKE_END_RE.test(text(j)) && !COPYRIGHT_RE.test(text(j));
    // A line of dialogue ("— Botuesi?") is never a publisher line.
    // A publisher/store/web line is plain: never bigger than the body,
    // in a Title style or italic (a subtitle, a dedication's line, an
    // epigraph: audit r5 L1).
    const plainLook = (j: number) => {
      const f = para(j)!;
      return !bigger(f) && !f.italic && !/^(?:title|subtitle)$/i.test(f.styleName.trim());
    };
    const metaLine = (j: number) =>
      words(text(j)) <= MAX_META_LINE_WORDS &&
      !sentenceLike(j) &&
      !DIALOGUE_START_RE.test(text(j)) &&
      plainLook(j) &&
      (FRONT_META_RE.test(text(j)) || hasOutsideMention(text(j)));
    const separator = (j: number) => /^[\s_\-–—=*~.·•]{3,}$/u.test(text(j));
    // A line that can sit in the front part: a copyright, publisher or
    // separator line, or a short line that is not a sentence (a title,
    // a byline, a dedication). The story starts at anything else.
    const frontish = (j: number) =>
      copyrightLine(j) || metaLine(j) || separator(j) || (words(text(j)) <= MAX_TITLE_LINE_WORDS && !SENTENCE_LIKE_END_RE.test(text(j)));

    const front: number[] = [];
    let storyStarted = false;
    for (const j of textParas) {
      if ((firstChapter !== undefined && j >= firstChapter) || front.length >= MAX_FRONT_PARAS) break;
      // Without chapters the story starts at the first line that is not
      // front-page material; with chapters (the first one found may come
      // late, audit r2 M3), at the first prose paragraph.
      if (firstChapter === undefined ? !frontish(j) : storyLine(j)) {
        storyStarted = true;
        break;
      }
      if (isRemoved(j) || plans.get(j)?.replaceWithSceneBreak) continue;
      front.push(j);
    }
    const pages: number[][] = [];
    for (const j of front) {
      if (pages.length === 0 || newPage[j]) pages.push([]);
      pages[pages.length - 1].push(j);
    }
    // When the story started on the last page looked at, that page is
    // not a page of its own (audit r2 M2).
    const closed = (i: number) =>
      i + 1 < pages.length || (!storyStarted && firstChapter !== undefined && newPage[firstChapter]);

    const removedNow = new Set<number>();
    // `choiceSet`: for copyright lines, the author's undo (removed unless
    // listed); for a title page, the author's own "remove" (kept unless
    // listed: audit r4 showed the title cannot be told apart from a
    // dedication or a heading alone on page 1 without the book's title).
    const removeGroup = (lines: number[], kind: "copyright_page" | "title_page", sign: string, choiceSet: Set<number>) => {
      const own = lines.filter((j) => !removedNow.has(j));
      if (own.length === 0 || own.every(separator)) return;
      const listed = choiceSet.has(indexOf(own[0]));
      const kept = kind === "title_page" ? !listed : listed;
      for (const j of own) removedNow.add(j);
      if (!kept) {
        for (const j of own) {
          plan(j).remove = true;
          frontLinesRemoved++;
        }
      }
      guesses.push({
        paragraph: indexOf(own[0]),
        kind,
        // A title page offer shows every line it would remove, in full
        // (audit r5 L3); a copyright group is shortened as before.
        text: kind === "title_page" ? own.map(text).join(" / ") : truncate(own.map(text).join(" / ")),
        confidence: "high",
        applied: !kept,
        signs: [sign, ...(kind === "title_page" ? (kept ? [] : ["removed by the author"]) : kept ? ["kept by the author"] : [])],
      });
    };
    // Runs of touching copyright/meta/separator lines with a copyright
    // line in them.
    const runsOf = (list: number[]): number[][] => {
      const out: number[][] = [];
      let run: number[] = [];
      const flush = () => {
        if (run.some(copyrightLine)) out.push(run);
        run = [];
      };
      for (const j of list) {
        const fits = copyrightLine(j) || metaLine(j) || separator(j);
        if (fits && (run.length === 0 || emptiesBefore[j] < 2)) run.push(j);
        else {
          flush();
          if (fits) run.push(j);
        }
      }
      flush();
      return out;
    };

    pages.forEach((page, i) => {
      if (!page.some(copyrightLine)) return;
      if (closed(i)) {
        // A copyright page: its copyright, publisher and separator lines
        // go, wherever they are on it; nothing else.
        removeGroup(
          page.filter((j) => copyrightLine(j) || metaLine(j) || separator(j)),
          "copyright_page",
          "copyright page before the first chapter",
          keepCopyrightSet,
        );
        return;
      }
      for (const run of runsOf(page)) removeGroup(run, "copyright_page", "copyright lines before the story", keepCopyrightSet);
    });

    // A one-story book whose title became its only chapter: copyright
    // lines right under that title, before the story starts.
    if (firstChapter !== undefined && chapterSet.size === 1 && front.length === 0) {
      const leadIn: number[] = [];
      for (const j of textParas) {
        if (j <= firstChapter) continue;
        if (leadIn.length >= MAX_FRONT_PARAS || !frontish(j)) break;
        if (isRemoved(j) || plans.get(j)?.replaceWithSceneBreak) continue;
        leadIn.push(j);
      }
      for (const run of runsOf(leadIn)) removeGroup(run, "copyright_page", "copyright lines under the book's title", keepCopyrightSet);
    }

    // The typed title page: only its title line(s). A line is the
    // book's title when it is in Word's Title style, or bigger than the
    // body AND than every chapter title (a poem book's first poem looks
    // like the later ones: audit r1 H6). Nothing else on the page goes:
    // not a smaller author line, a byline, a year or a dedication
    // (audit r2 H1, H2, M1); a stray author name is harmless, a lost
    // dedication is not. A page with a prose paragraph on it is not a
    // title page (audit r2 M2).
    if (firstChapter !== undefined && pages.length > 0 && closed(0)) {
      const page = pages[0];
      const isTitleStyle = (j: number) => /^title$/i.test(para(j)!.styleName.trim());
      const chapterSizes = [...chapterSet].map((j) => para(j)?.size ?? null).filter((x): x is number => x !== null);
      const biggest = chapterSizes.length > 0 ? Math.max(...chapterSizes) : median;
      const titleLine = (j: number) =>
        words(text(j)) <= MAX_TITLE_LINE_WORDS &&
        !SENTENCE_LIKE_END_RE.test(text(j)) &&
        !PART_HEADING_RE.test(text(j)) &&
        !LABEL_ONLY_RE.test(text(j)) &&
        !DEDICATION_START_RE.test(text(j)) &&
        !para(j)!.italic;
      // Audit r3 H1: with a Title-style line, only that line is the
      // title; otherwise only the line(s) at the page's largest size,
      // when that size is above the body and every chapter title.
      const titleStyled = page.filter(isTitleStyle);
      const sizes = page.map((j) => para(j)!.size ?? 0);
      const pageMax = Math.max(0, ...sizes);
      const anchor = (j: number) =>
        titleLine(j) &&
        (titleStyled.length > 0
          ? isTitleStyle(j)
          : bigger(para(j)!) && (para(j)!.size ?? 0) === pageMax && pageMax > biggest);
      const prosePara = page.some((j) => words(text(j)) > MAX_TITLE_LINE_WORDS);
      if (!prosePara && page.length <= 12) {
        removeGroup(
          page.filter(anchor),
          "title_page",
          "typed title page; Librum's own page shows the title and the author",
          removeTitlePageSet,
        );
      }
    }
  }

  // ---- 6. alignment, poems ----
  const isHeading = (j: number) =>
    chapterSet.has(j) || subSet.has(j) || (!!para(j)?.headingLevel && plans.get(j)?.style !== "plain");
  const plain = textParas.filter((j) => !isHeading(j) && !isRemoved(j) && !plans.get(j)?.replaceWithSceneBreak);
  const plainSet = new Set(plain);
  const centeredCount = plain.filter((j) => centered(para(j)!)).length;
  const centerMeaningful = plain.length === 0 || centeredCount / plain.length <= 0.5;
  const tabCounts = new Map<number, number>();
  for (const j of plain) tabCounts.set(para(j)!.leadingTabs, (tabCounts.get(para(j)!.leadingTabs) ?? 0) + 1);
  let bodyTabs = 0;
  let bodyTabsCount = -1;
  for (const [t, c] of tabCounts) if (c > bodyTabsCount) { bodyTabs = t; bodyTabsCount = c; }
  const hasOwnStyle = (f: ParaFacts) => !!f.styleId && /^(quote|intense quote|list paragraph)$/i.test(f.styleName.trim());

  for (const j of plain) {
    const f = para(j)!;
    if (hasOwnStyle(f) || f.num || f.hasObject) continue;
    const len = f.trimmed.length;
    if (f.align === "center" && len <= 600 && centerMeaningful) plan(j).style = "center";
    else if ((f.align === "right" || f.align === "end") && len <= 600) plan(j).style = "right";
    else if (f.leadingTabs >= 2 && f.leadingTabs > bodyTabs && len <= 120) plan(j).style = "verseIndent";
    else if (f.lineBreaks >= 2) {
      const lines = f.trimmed.split("\n");
      const avg = lines.reduce((s, l) => s + l.length, 0) / lines.length;
      if (avg <= 60) plan(j).style = "verse";
    }
  }
  // Poems typed one line per paragraph: 4+ short lines in a row (empty
  // lines between = stanza gaps), mostly not ending like sentences.
  {
    const notVerseSet = new Set(options.notVerse ?? []);
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 4) {
        const open = run.filter((j) => !/[.!?…"”»]$/.test(para(j)!.trimmed)).length;
        if (open / run.length >= 0.6) {
          const off = notVerseSet.has(indexOf(run[0]));
          if (!off) {
            run.forEach((j, idx) => {
              plan(j).style = idx > 0 && emptiesBefore[j] > 0 ? "verseStanza" : "verse";
            });
          }
          guesses.push({
            paragraph: indexOf(run[0]),
            kind: "verse",
            text: truncate(para(run[0])!.trimmed),
            confidence: "medium",
            applied: !off,
            signs: [`${run.length} short lines`, ...(off ? ["kept as normal text by the author"] : [])],
          });
        }
      }
      run = [];
    };
    const eligible = (j: number) => {
      const f = para(j)!;
      return (
        plainSet.has(j) && !plans.get(j)?.style && !hasOwnStyle(f) && !f.num && f.lineBreaks === 0 &&
        f.trimmed.length <= 60 && !DIALOGUE_RE.test(f.trimmed)
      );
    };
    const adjacent = (a: number, b: number) => {
      if (emptiesBefore[b] > 2 || newPage[b]) return false;
      for (let k = a + 1; k < b; k++) {
        const f = para(k);
        if (!f || !(f.empty || isRemoved(k))) return false;
      }
      return true;
    };
    for (const j of textParas) {
      if (!eligible(j)) {
        flush();
        continue;
      }
      if (run.length > 0 && !adjacent(run[run.length - 1], j)) flush();
      run.push(j);
    }
    flush();
  }

  // Prose typed with Shift+Enter instead of Enter: long lines, or lines
  // indented after each break, become separate paragraphs.
  let paragraphsSplit = 0;
  const keepLinesSet = new Set(options.keepLines ?? []);
  for (const j of plain) {
    const f = para(j)!;
    if (f.lineBreaks === 0 || plans.get(j)?.style || hasOwnStyle(f) || f.num || f.hasObject) continue;
    const lines = f.trimmed.split("\n");
    const avg = lines.reduce((sum, l) => sum + l.trim().length, 0) / lines.length;
    const indented = lines.slice(1).filter((l) => /^[\t ]{2,}|^\t/.test(l)).length;
    if (avg > 60 || indented >= Math.max(1, (lines.length - 1) / 2)) {
      const keep = keepLinesSet.has(indexOf(j));
      if (!keep) {
        plan(j).splitAtBreaks = true;
        paragraphsSplit += lines.length - 1;
      }
      if (lines.length >= 2) guesses.push({
        paragraph: indexOf(j),
        kind: "split_lines",
        text: truncate(f.trimmed),
        confidence: "medium",
        applied: !keep,
        signs: [`${lines.length} lines typed with Shift+Enter`, avg > 60 ? "long lines" : "indented lines"],
      });
    }
  }

  // ---- 7. scene breaks from empty lines (answer 4a, D1 = a) ----
  // Two or more empty lines between ordinary paragraphs are a scene
  // break; a single empty line (often a stray Enter) is only offered to
  // the author as a suggestion (applied: false). Whether the author uses
  // empty lines as plain spacing is decided per chapter, not for the
  // whole book (audit R2): one chapter pasted from an e-mail must not
  // fill with "* * *".
  const ordinary = (j: number) => {
    const f = para(j);
    return (
      !!f && !f.empty && !isRemoved(j) && !isHeading(j) && !plans.get(j)?.style &&
      !plans.get(j)?.replaceWithSceneBreak && !f.hasObject && !hasOwnStyle(f) && !NOT_A_TITLE_RE.test(f.trimmed) &&
      // List items (Word numbering or bullets) belong to their list.
      !f.num &&
      // Quoted letters, epigraphs and subtitles are set in italics; a
      // blank line next to them marks the quote, not a new scene.
      !f.italic && f.align !== "center" && f.align !== "right"
    );
  };
  type Pair = { b: number; seg: number; spaced?: boolean };
  const pairs: Pair[] = [];
  const contentPos = new Map<number, number>(); // block -> position among content paragraphs
  const segStartPos: number[] = [];
  {
    let prev = -1;
    let seg = -1;
    let count = 0;
    for (let j = 0; j < n; j++) {
      const f = para(j);
      if (f && (f.empty || isRemoved(j))) continue;
      if (seg < 0 || newPage[j] || chapterSet.has(j) || f?.headingLevel === 1) {
        seg++;
        segStartPos[seg] = count;
      }
      contentPos.set(j, count++);
      if (prev >= 0 && ordinary(prev) && ordinary(j) && !newPage[j]) {
        // Never from a single empty line right before a chapter's last
        // paragraph (a closing quote or line set apart).
        const k = nextContent(j);
        const last = k < 0 || newPage[k] || isHeading(k);
        // A paragraph ending in ":" introduces what follows (a list, a
        // letter); the empty line after it is not a new scene.
        const intro = /:["”»’)]*$/.test(para(prev)!.trimmed);
        if (!(last && emptiesBefore[j] === 1) && !(intro && emptiesBefore[j] > 0)) pairs.push({ b: j, seg });
      }
      prev = j;
    }
  }
  const candidates: Pair[] = [];
  {
    const bySeg = new Map<number, Pair[]>();
    for (const p of pairs) {
      const list = bySeg.get(p.seg) ?? [];
      list.push(p);
      bySeg.set(p.seg, list);
    }
    for (const list of bySeg.values()) {
      const gaps = list.filter((p) => emptiesBefore[p.b] > 0);
      // "Spaced" needs evidence: a few empty lines in a short chapter
      // are breaks.
      const spaced = gaps.length >= 3 && gaps.length / list.length >= 0.3;
      // In a spaced chapter, only a gap longer than the usual one can be
      // a break, and the author's spacing is irregular there, so it is
      // only suggested.
      let usual = 0;
      if (spaced) {
        const freq = new Map<number, number>();
        for (const p of gaps) freq.set(emptiesBefore[p.b], (freq.get(emptiesBefore[p.b]) ?? 0) + 1);
        let best = -1;
        for (const [g, c] of freq) if (c > best || (c === best && g < usual)) { best = c; usual = g; }
      }
      for (const p of gaps) {
        const e = emptiesBefore[p.b];
        // Many empty lines in a row push text down a page (front
        // matter); they don't separate scenes.
        if (e > usual && e <= 3) candidates.push({ ...p, spaced });
      }
    }
  }
  // Density guard (audit R2): scenes are several paragraphs long. Empty
  // lines fewer than 3 paragraphs apart (dialogue lines, a pasted block)
  // are spacing: no breaks at all in that cluster. A lone break within
  // 3 paragraphs of the chapter start is only a suggestion.
  const dense = new Set<number>();
  const nearStart = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const pos = contentPos.get(c.b)!;
    const prevC = i > 0 && candidates[i - 1].seg === c.seg ? candidates[i - 1] : null;
    if (prevC && pos - contentPos.get(prevC.b)! < 3) {
      dense.add(prevC.b);
      dense.add(c.b);
    } else if (!prevC && pos - segStartPos[c.seg] < 3) nearStart.add(c.b);
  }
  let sceneBreaks = 0;
  const sceneBreakSet = new Set(options.sceneBreak ?? []);
  const noSceneBreakSet = new Set(options.noSceneBreak ?? []);
  for (const c of candidates) {
    if (dense.has(c.b)) continue;
    const e = emptiesBefore[c.b];
    const auto = e >= 2 && !nearStart.has(c.b) && !c.spaced;
    // The author's choice in the preview wins (W4).
    const byAuthor = noSceneBreakSet.has(indexOf(c.b)) ? false : sceneBreakSet.has(indexOf(c.b)) ? true : null;
    const apply = byAuthor ?? auto;
    if (apply) plan(c.b).sceneBreakBefore = true;
    guesses.push({
      paragraph: indexOf(c.b),
      kind: "scene_break",
      text: truncate(para(c.b)!.trimmed),
      confidence: auto ? "high" : "medium",
      applied: apply,
      signs: [
        `${e} empty line${e > 1 ? "s" : ""} between paragraphs`,
        ...(nearStart.has(c.b) ? ["close to the chapter start"] : []),
        ...(c.spaced ? ["the chapter uses empty lines as spacing"] : []),
        ...(byAuthor !== null && byAuthor !== auto ? [byAuthor ? "added by the author" : "taken out by the author"] : []),
      ],
    });
  }
  // Typed markers: never at the very start or end of a chapter.
  for (let j = 0; j < n; j++) {
    if (!plans.get(j)?.replaceWithSceneBreak) continue;
    const k = nextContent(j);
    let prevJ = -1;
    for (let b = j - 1; b >= 0; b--) {
      const f = para(b);
      if (f && (f.empty || isRemoved(b))) continue;
      prevJ = b;
      break;
    }
    if (k < 0 || isHeading(k) || prevJ < 0 || isHeading(prevJ) || plans.get(k)?.replaceWithSceneBreak) {
      plan(j).replaceWithSceneBreak = false;
      plan(j).remove = true;
      continue;
    }
    if (plans.get(k)?.sceneBreakBefore) plan(k).sceneBreakBefore = false;
    sceneBreaks++;
  }
  sceneBreaks += [...plans.values()].filter((p) => p.sceneBreakBefore).length;

  // ---- 7b. blank lines around lines set apart (W3 Part 2, answer 4a) ----
  // Renato's staging try-out (31 Oct): a centered heading or couplet
  // with empty lines around it in Word was stuck to the text in the
  // ebook. Where Word had empty lines between a centered or right-aligned
  // line, block or poem and the text next to it, the ebook keeps one
  // blank line, however many there were. A page break inside a chapter
  // counts like empty lines (Renato's audit answer Q1a, 31 Oct): ebooks
  // drop page breaks there, so the line would be stuck to the text
  // above. Lines inside a block stay tight (no empty lines between them
  // in Word, no gap). Never at a chapter start or next to a heading
  // (headings have their own space), where a scene break already is,
  // or before a poem's stanza (it has its own).
  const setApart = (j: number) => {
    const s = plans.get(j)?.style;
    return s === "center" || s === "right" || s === "verse" || s === "verseStanza" || s === "verseIndent";
  };
  let gaps = 0;
  {
    let prev = -1;
    for (let j = 0; j < n; j++) {
      const f = para(j);
      if (f && (f.empty || isRemoved(j))) continue;
      const p = plans.get(j);
      if (
        prev >= 0 && (emptiesBefore[j] > 0 || newPage[j]) && (setApart(prev) || setApart(j)) &&
        !isHeading(prev) && !isHeading(j) && !p?.sceneBreakBefore && !p?.replaceWithSceneBreak &&
        !plans.get(prev)?.replaceWithSceneBreak && p?.style !== "verseStanza"
      ) {
        plan(j).gapBefore = true;
        gaps++;
      }
      prev = j;
    }
  }

  // ---- 8. empty paragraphs go (their meaning is decided above) ----
  let emptyRemoved = 0;
  for (let j = 0; j < n; j++) {
    const f = para(j);
    if (f && f.empty && !plans.get(j)?.remove) {
      plan(j).remove = true;
      emptyRemoved++;
    }
  }

  return {
    plans,
    guesses: guesses.slice(0, 1000),
    chapterSource,
    chapters: chapterSet.size,
    subheadings: subSet.size,
    sceneBreaks,
    contentsLinesRemoved,
    frontLinesRemoved,
    emptyRemoved,
    paragraphsSplit,
    gaps,
  };
}
