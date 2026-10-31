import type { CleanupReport } from "@/lib/docx-cleanup";
import type { CleanupGuess, GuessKind } from "@/lib/docx-structure";

// W4: the author's choices in the ebook preview (Renato 31 Oct, 1a-6a).
// Every choice names a Word paragraph by its number in the original
// file (CleanupGuess.paragraph), so the same file, sent again from the
// browser, is rebuilt from scratch with all choices applied at once.
// Pure and shared by the server action (which re-validates whatever the
// browser sends) and the preview screen.

export const CHOICE_LISTS = [
  "makeChapter",
  "notChapter",
  "keepLines",
  "keepContents",
  "keepTitleApart",
  "sceneBreak",
  "noSceneBreak",
  "notSubheading",
  "notVerse",
] as const;
export type ChoiceList = (typeof CHOICE_LISTS)[number];

export type PreviewChoices = Record<ChoiceList, number[]> & { fixQuotes: boolean };

// Bounds for what the browser may send: a paragraph number is at most
// a few hundred thousand in a real book; a list is never longer than
// the guesses a build reports (1,000) plus the author's own taps.
export const MAX_CHOICES_PER_LIST = 5_000;
export const MAX_PARAGRAPH_NUMBER = 10_000_000;

export function emptyChoices(): PreviewChoices {
  return {
    makeChapter: [],
    notChapter: [],
    keepLines: [],
    keepContents: [],
    keepTitleApart: [],
    sceneBreak: [],
    noSceneBreak: [],
    notSubheading: [],
    notVerse: [],
    fixQuotes: true,
  };
}

// Whatever comes from the browser: an object with only the known keys,
// each a list of whole paragraph numbers. Anything else -> null.
export function normalizeChoices(raw: unknown): PreviewChoices | null {
  if (raw === undefined || raw === null) return emptyChoices();
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const input = raw as Record<string, unknown>;
  const known = new Set<string>([...CHOICE_LISTS, "fixQuotes"]);
  for (const key of Object.keys(input)) if (!known.has(key)) return null;
  const out = emptyChoices();
  for (const key of CHOICE_LISTS) {
    const value = input[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.length > MAX_CHOICES_PER_LIST) return null;
    for (const n of value) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > MAX_PARAGRAPH_NUMBER) return null;
    }
    out[key] = [...new Set(value as number[])].sort((a, b) => a - b);
  }
  if (input.fixQuotes !== undefined) {
    if (typeof input.fixQuotes !== "boolean") return null;
    out.fixQuotes = input.fixQuotes;
  }
  return out;
}

export function choicesEqual(a: PreviewChoices, b: PreviewChoices): boolean {
  if (a.fixQuotes !== b.fixQuotes) return false;
  return CHOICE_LISTS.every((k) => {
    const x = [...new Set(a[k])].sort((m, n) => m - n);
    const y = [...new Set(b[k])].sort((m, n) => m - n);
    return x.length === y.length && x.every((v, i) => v === y[i]);
  });
}

// ---------- guesses ----------

// For each kind: the list that turns it off (undo) and the list that
// turns it on (only where the clean-up pass has one).
const GUESS_LISTS: Record<GuessKind, { off?: ChoiceList; on?: ChoiceList }> = {
  chapter: { off: "notChapter", on: "makeChapter" },
  subheading: { off: "notSubheading" },
  scene_break: { off: "noSceneBreak", on: "sceneBreak" },
  typed_contents: { off: "keepContents" },
  merged_title: { off: "keepTitleApart" },
  split_lines: { off: "keepLines" },
  verse: { off: "notVerse" },
  title_page: {},
};

function has(choices: PreviewChoices, list: ChoiceList | undefined, p: number): boolean {
  return !!list && choices[list].includes(p);
}

function withMember(choices: PreviewChoices, list: ChoiceList | undefined, p: number, member: boolean): PreviewChoices {
  if (!list) return choices;
  const rest = choices[list].filter((x) => x !== p);
  return { ...choices, [list]: member ? [...rest, p].sort((a, b) => a - b) : rest };
}

function signature(choices: PreviewChoices, kind: GuessKind, p: number): string {
  const { off, on } = GUESS_LISTS[kind];
  return `${has(choices, off, p)}|${has(choices, on, p)}`;
}

function restore(choices: PreviewChoices, applied: PreviewChoices, kind: GuessKind, p: number): PreviewChoices {
  const { off, on } = GUESS_LISTS[kind];
  return withMember(withMember(choices, off, p, has(applied, off, p)), on, p, has(applied, on, p));
}

// `applied` = the choices the shown build was made with. A guess's
// `applied` flag describes that build.
export function isGuessPending(guess: CleanupGuess, choices: PreviewChoices, applied: PreviewChoices): boolean {
  return signature(choices, guess.kind, guess.paragraph) !== signature(applied, guess.kind, guess.paragraph);
}

// What the book will have after "Apply": the build's state, flipped
// when the author changed this guess.
export function guessWillApply(guess: CleanupGuess, choices: PreviewChoices, applied: PreviewChoices): boolean {
  return isGuessPending(guess, choices, applied) ? !guess.applied : guess.applied;
}

export function canToggleGuess(guess: CleanupGuess, applied: PreviewChoices): boolean {
  const { off, on } = GUESS_LISTS[guess.kind];
  if (guess.applied) return !!off;
  return !!on || has(applied, off, guess.paragraph);
}

export function toggleGuess(guess: CleanupGuess, choices: PreviewChoices, applied: PreviewChoices): PreviewChoices {
  if (isGuessPending(guess, choices, applied)) return restore(choices, applied, guess.kind, guess.paragraph);
  if (!canToggleGuess(guess, applied)) return choices;
  const { off, on } = GUESS_LISTS[guess.kind];
  const p = guess.paragraph;
  if (guess.applied) return withMember(withMember(choices, on, p, false), off, p, true);
  return withMember(withMember(choices, off, p, false), on, p, true);
}

// ---------- taps in the reading view ----------

export type TapAction = "makeChapter" | "notChapter" | "noSceneBreak";

// A line short enough to be a chapter title (the clean-up pass's own
// title candidates are at most 90 characters; a little room for a
// label merged with its title).
export const MAX_CHAPTER_TITLE_CHARS = 120;

export function applyTap(choices: PreviewChoices, action: TapAction, p: number): PreviewChoices {
  if (action === "makeChapter") return withMember(withMember(choices, "notChapter", p, false), "makeChapter", p, true);
  if (action === "notChapter") return withMember(withMember(choices, "makeChapter", p, false), "notChapter", p, true);
  return withMember(withMember(choices, "sceneBreak", p, false), "noSceneBreak", p, true);
}

export function undoTap(choices: PreviewChoices, applied: PreviewChoices, action: TapAction, p: number): PreviewChoices {
  const kind: GuessKind = action === "noSceneBreak" ? "scene_break" : "chapter";
  return restore(choices, applied, kind, p);
}

// The author's own changes not yet applied, one row per paragraph and
// kind, for the "your changes" list.
export type PendingChange = { kind: "chapter" | "scene_break" | "other"; paragraph: number; on: boolean };

export function pendingChanges(choices: PreviewChoices, applied: PreviewChoices): PendingChange[] {
  const out: PendingChange[] = [];
  const seen = new Set<string>();
  for (const list of CHOICE_LISTS) {
    for (const p of [...choices[list], ...applied[list]]) {
      const kind: PendingChange["kind"] =
        list === "makeChapter" || list === "notChapter" ? "chapter" : list === "sceneBreak" || list === "noSceneBreak" ? "scene_break" : "other";
      const key = `${kind === "other" ? list : kind}:${p}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const differs =
        kind === "chapter"
          ? signature(choices, "chapter", p) !== signature(applied, "chapter", p)
          : kind === "scene_break"
            ? signature(choices, "scene_break", p) !== signature(applied, "scene_break", p)
            : choices[list].includes(p) !== applied[list].includes(p);
      if (!differs) continue;
      const on =
        kind === "chapter" ? choices.makeChapter.includes(p) : kind === "scene_break" ? choices.sceneBreak.includes(p) : choices[list].includes(p);
      out.push({ kind, paragraph: p, on });
    }
  }
  return out;
}

export function pendingCount(choices: PreviewChoices, applied: PreviewChoices): number {
  return pendingChanges(choices, applied).length + (choices.fixQuotes !== applied.fixQuotes ? 1 : 0);
}

// ---------- words for the author (Albanian) ----------

export type GuessWords = { state: string; action: string | null; unsure: boolean };

const q = (t: string) => `“${t}”`;

export function describeGuess(guess: CleanupGuess, on: boolean, canToggle: boolean): GuessWords {
  const t = q(guess.text);
  const unsure = guess.confidence !== "high";
  const act = (s: string) => (canToggle ? s : null);
  switch (guess.kind) {
    case "chapter":
      return on
        ? { state: `Fillim kapitulli: ${t}`, action: act("Nuk është kapitull"), unsure }
        : { state: `Mund të jetë fillim kapitulli: ${t}`, action: act("Bëje kapitull"), unsure };
    case "subheading":
      return on
        ? { state: `Nëntitull brenda kapitullit: ${t}`, action: act("Ktheje në tekst të zakonshëm"), unsure }
        : { state: `Tekst i zakonshëm (Librum mendoi se ishte nëntitull): ${t}`, action: act("Bëje sërish nëntitull"), unsure };
    case "scene_break":
      return on
        ? { state: `Ndarje skene (* * *) para rreshtit: ${t}`, action: act("Hiqe ndarjen"), unsure }
        : { state: `Një rresht bosh para: ${t}. Mund të jetë ndarje skene.`, action: act("Shto ndarje skene"), unsure };
    case "typed_contents":
      return on
        ? { state: `U hoq përmbajtja e shkruar me dorë që fillon me ${t}. Librum e krijon vetë përmbajtjen e e-librit.`, action: act("Ktheje në libër"), unsure }
        : { state: `Përmbajtja e shkruar me dorë mbetet në libër: ${t}`, action: act("Hiqe"), unsure };
    case "merged_title":
      return on
        ? { state: `U bashkuan në një titull: ${t}`, action: act("Mbaji veçmas"), unsure }
        : { state: `Mbeten veçmas: ${t}`, action: act("Bashkoji në një titull"), unsure };
    case "split_lines":
      return on
        ? { state: `Rreshtat e shkruar me Shift+Enter u ndanë në paragrafë: ${t}`, action: act("Mbaji në një paragraf"), unsure }
        : { state: `Mbetet një paragraf me disa rreshta: ${t}`, action: act("Ndaji në paragrafë"), unsure };
    case "verse":
      return on
        ? { state: `U formatua si poezi (rreshta të shkurtër): ${t}`, action: act("Ktheje në prozë"), unsure }
        : { state: `Mbetet prozë: ${t}`, action: act("Formatoje si poezi"), unsure };
    case "title_page":
      return { state: `Faqja e titullit e shkruar në dokument mbetet në fillim të librit: ${t}`, action: null, unsure: false };
  }
}

// The summary of what Librum changed, only the fixes that happened.
export function describeFixes(report: CleanupReport): string[] {
  if (!report.applied) return [];
  const f = report.fixes;
  const lines: string[] = [];
  const add = (n: number, text: string) => {
    if (n > 0) lines.push(`${n} ${text}`);
  };
  lines.push(
    report.chapters > 0
      ? `${report.chapters} kapituj${report.chapterSource === "detected" ? " të gjetur nga Librum" : " nga stilet Heading të Word-it"}`
      : "Asnjë kapitull i gjetur: libri është një pjesë e vetme",
  );
  add(report.subheadings, "nëntituj");
  add(report.sceneBreaks, "ndarje skenash (* * *)");
  add(f.contentsLinesRemoved, "rreshta përmbajtjeje të hequr (Librum e krijon vetë përmbajtjen)");
  add(f.emptyLinesRemoved, "rreshta bosh të hequr");
  add(f.indentsRemoved, "kryeradhë me hapësira ose Tab të hequra");
  add(f.paragraphsSplit, "paragrafë të ndarë (rreshta me Shift+Enter)");
  add(f.quotes, "thonjëza të rregulluara");
  add(f.apostrophes, "apostrofa të rregulluar");
  add(f.ellipses, "tre pika të kthyera në …");
  add(f.dashes, "viza të rregulluara");
  add(f.dropCapsJoined, "shkronja fillestare të mëdha të bashkuara me fjalën");
  add(f.headingNumbersAdded, "numra titujsh nga Word-i të ruajtur");
  return lines;
}

// W3 Part 2: the health report in the preview's "Çfarë bëri Librum" box
// (Renato's I4, 31 Oct): green lines for what Librum found and fixed,
// amber lines for what the author should look at. Warnings from the
// conversion are amber lines too.
export type HealthLine = { tone: "ok" | "check"; text: string };

export function healthReport(report: CleanupReport, warnings: { message: string }[] = []): HealthLine[] {
  const lines: HealthLine[] = [];
  const fixes = describeFixes(report);
  const notes = report.notes ?? { footnotes: 0, endnotes: 0, dropped: 0 };
  if (fixes.length > 0) {
    lines.push({ tone: report.chapters > 0 ? "ok" : "check", text: fixes[0] });
  }
  if (notes.footnotes > 0) lines.push({ tone: "ok", text: `${notes.footnotes} shënime në fund të faqes, të ruajtura në fund të kapitullit të vet` });
  if (notes.endnotes > 0) lines.push({ tone: "ok", text: `${notes.endnotes} shënime në fund të librit, të ruajtura në kapitullin “Shënime”` });
  if ((report.gaps ?? 0) > 0) lines.push({ tone: "ok", text: `${report.gaps} rreshta bosh të ruajtur rreth rreshtave në qendër dhe poezive` });
  const broken = report.fixes.brokenLetters ?? 0;
  if (broken > 0) lines.push({ tone: "ok", text: `${broken} shkronja të prishura të rregulluara (p.sh. “Ã«” në “ë”)` });
  for (const f of fixes.slice(1)) lines.push({ tone: "ok", text: f });
  const unsure = report.guesses.filter((g) => g.confidence !== "high" && g.kind !== "title_page").length;
  if (unsure > 0) lines.push({ tone: "check", text: `${unsure} vende ku Librum nuk është i sigurt: shihini te “Kontrolloni këto”` });
  const missing = report.missingLetters;
  if (missing) {
    const list = missing.words.map((w) => `“${w.word}” (${w.count}) në vend të “${w.correct}”`).join(", ");
    lines.push({
      tone: "check",
      text: `${missing.total} fjalë duken të shkruara pa ë ose ç: ${list}. Librum nuk i ndryshon vetë; rregullojini në Word dhe ngarkojeni dokumentin sërish.`,
    });
  }
  for (const w of warnings) lines.push({ tone: "check", text: w.message });
  return lines;
}

// Sorted for the list: unsure ones first, then in book order.
export function guessesForList(report: CleanupReport): CleanupGuess[] {
  return report.guesses
    .slice()
    .sort((a, b) => Number(a.confidence === "high") - Number(b.confidence === "high") || a.paragraph - b.paragraph);
}
