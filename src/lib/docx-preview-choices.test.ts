import { describe, expect, it } from "vitest";
import {
  applyTap,
  canToggleGuess,
  choicesEqual,
  describeFixes,
  describeGuess,
  emptyChoices,
  guessWillApply,
  healthReport,
  isGuessPending,
  normalizeChoices,
  pendingChanges,
  pendingCount,
  toggleGuess,
  undoTap,
} from "./docx-preview-choices";
import { emptyCleanupReport } from "./docx-cleanup";
import type { CleanupGuess } from "./docx-structure";

const guess = (over: Partial<CleanupGuess>): CleanupGuess => ({
  paragraph: 7,
  kind: "chapter",
  text: "Liqeni",
  confidence: "high",
  applied: true,
  signs: [],
  ...over,
});

describe("normalizeChoices", () => {
  it("accepts nothing as no choices, and sorts and de-duplicates lists", () => {
    expect(normalizeChoices(undefined)).toEqual(emptyChoices());
    expect(normalizeChoices({ makeChapter: [5, 2, 5], fixQuotes: false })).toMatchObject({ makeChapter: [2, 5], fixQuotes: false });
  });

  it("refuses anything that isn't lists of whole paragraph numbers", () => {
    for (const bad of [
      "x", 1, [1], { makeChapter: "1" }, { makeChapter: [1.5] }, { makeChapter: [-1] }, { makeChapter: [10_000_001] },
      { makeChapter: ["1"] }, { other: [] }, { fixQuotes: 1 }, { makeChapter: new Array(5001).fill(1) },
    ]) {
      expect(normalizeChoices(bad)).toBeNull();
    }
  });
});

describe("toggling a guess", () => {
  const applied = emptyChoices();

  it("undoes an applied chapter, and a second tap goes back to the build", () => {
    const g = guess({});
    const once = toggleGuess(g, applied, applied);
    expect(once.notChapter).toEqual([7]);
    expect(isGuessPending(g, once, applied)).toBe(true);
    expect(guessWillApply(g, once, applied)).toBe(false);
    const twice = toggleGuess(g, once, applied);
    expect(choicesEqual(twice, applied)).toBe(true);
    expect(guessWillApply(g, twice, applied)).toBe(true);
  });

  it("applies an unsure chapter, and keeps working after a rebuild with that choice", () => {
    const g = guess({ applied: false, confidence: "medium" });
    const chosen = toggleGuess(g, applied, applied);
    expect(chosen.makeChapter).toEqual([7]);
    // After "Apply": the new build reports it applied, made with `chosen`.
    const rebuilt = guess({ applied: true, confidence: "medium" });
    expect(isGuessPending(rebuilt, chosen, chosen)).toBe(false);
    const undo = toggleGuess(rebuilt, chosen, chosen);
    expect(undo.makeChapter).toEqual([]);
    expect(undo.notChapter).toEqual([7]);
  });

  it("maps every kind to its own choice list", () => {
    expect(toggleGuess(guess({ kind: "scene_break", applied: false }), applied, applied).sceneBreak).toEqual([7]);
    expect(toggleGuess(guess({ kind: "scene_break" }), applied, applied).noSceneBreak).toEqual([7]);
    expect(toggleGuess(guess({ kind: "typed_contents" }), applied, applied).keepContents).toEqual([7]);
    expect(toggleGuess(guess({ kind: "merged_title" }), applied, applied).keepTitleApart).toEqual([7]);
    expect(toggleGuess(guess({ kind: "split_lines" }), applied, applied).keepLines).toEqual([7]);
    expect(toggleGuess(guess({ kind: "verse" }), applied, applied).notVerse).toEqual([7]);
    expect(toggleGuess(guess({ kind: "subheading" }), applied, applied).notSubheading).toEqual([7]);
  });

  it("offers no toggle where the clean-up pass has no switch", () => {
    expect(canToggleGuess(guess({ kind: "title_page", applied: false }), applied)).toBe(false);
    // An unsure typed contents list the pass kept: there is no "remove it" option.
    expect(canToggleGuess(guess({ kind: "typed_contents", applied: false }), applied)).toBe(false);
    // But one the author kept can be removed again.
    expect(canToggleGuess(guess({ kind: "typed_contents", applied: false }), { ...applied, keepContents: [7] })).toBe(true);
    const g = guess({ kind: "title_page", applied: false });
    expect(toggleGuess(g, applied, applied)).toBe(applied);
  });
});

describe("taps in the reading view", () => {
  it("makes a line a chapter, takes out a chapter or a break, and can be undone", () => {
    const applied = emptyChoices();
    const made = applyTap(applied, "makeChapter", 12);
    expect(made.makeChapter).toEqual([12]);
    expect(pendingChanges(made, applied)).toEqual([{ kind: "chapter", paragraph: 12, on: true }]);
    expect(pendingCount(made, applied)).toBe(1);
    expect(choicesEqual(undoTap(made, applied, "makeChapter", 12), applied)).toBe(true);

    const notCh = applyTap(made, "notChapter", 12);
    expect(notCh.makeChapter).toEqual([]);
    expect(notCh.notChapter).toEqual([12]);

    const noBreak = applyTap({ ...applied, sceneBreak: [3] }, "noSceneBreak", 3);
    expect(noBreak.sceneBreak).toEqual([]);
    expect(noBreak.noSceneBreak).toEqual([3]);
  });

  it("counts the quotes switch as a change", () => {
    const applied = emptyChoices();
    expect(pendingCount({ ...applied, fixQuotes: false }, applied)).toBe(1);
  });
});

describe("words for the author", () => {
  it("describes each guess with an action only when it can be toggled", () => {
    expect(describeGuess(guess({}), true, true)).toEqual({ state: "Fillim kapitulli: “Liqeni”", action: "Nuk është kapitull", unsure: false });
    expect(describeGuess(guess({ confidence: "medium" }), false, true).action).toBe("Bëje kapitull");
    expect(describeGuess(guess({ confidence: "medium" }), false, true).unsure).toBe(true);
    expect(describeGuess(guess({}), true, false).action).toBeNull();
  });

  it("lists only the fixes that happened", () => {
    const r = emptyCleanupReport();
    expect(describeFixes(r)).toEqual([]);
    r.applied = true;
    r.chapters = 3;
    r.chapterSource = "detected";
    r.fixes.quotes = 4;
    expect(describeFixes(r)).toEqual(["3 kapituj të gjetur nga Librum", "4 thonjëza të rregulluara"]);
  });
});

describe("W3 Part 2 health report", () => {
  it("shows what Librum did in green and what to look at in amber", () => {
    const r = emptyCleanupReport();
    r.applied = true;
    r.chapters = 7;
    r.chapterSource = "detected";
    r.notes = { footnotes: 53, endnotes: 2, dropped: 0 };
    r.gaps = 4;
    r.fixes.brokenLetters = 3;
    r.fixes.quotes = 2;
    r.guesses = [guess({ confidence: "medium", paragraph: 1 }), guess({ confidence: "high", paragraph: 2 }), guess({ kind: "title_page", confidence: "medium", paragraph: 0 })];
    r.missingLetters = { total: 31, words: [{ word: "eshte", correct: "është", count: 20 }, { word: "nje", correct: "një", count: 11 }] };
    const lines = healthReport(r, [{ message: "Tabelat u kthyen." }]);
    expect(lines).toEqual([
      { tone: "ok", text: "7 kapituj të gjetur nga Librum" },
      { tone: "ok", text: "53 shënime në fund të faqes, të ruajtura në fund të kapitullit të vet" },
      { tone: "ok", text: "2 shënime në fund të librit, të ruajtura në kapitullin “Shënime”" },
      { tone: "ok", text: "4 rreshta bosh të ruajtur rreth rreshtave në qendër dhe poezive" },
      { tone: "ok", text: "3 shkronja të prishura të rregulluara (p.sh. “Ã«” në “ë”)" },
      { tone: "ok", text: "2 thonjëza të rregulluara" },
      { tone: "check", text: "1 vende ku Librum nuk është i sigurt: shihini te “Kontrolloni këto”" },
      {
        tone: "check",
        text: "31 fjalë duken të shkruara pa ë ose ç: “eshte” (20) në vend të “është”, “nje” (11) në vend të “një”. Librum nuk i ndryshon vetë; rregullojini në Word dhe ngarkojeni dokumentin sërish.",
      },
      { tone: "check", text: "Tabelat u kthyen." },
    ]);
  });

  it("marks a book with no chapters amber, and shows notes even without the clean-up changes", () => {
    const r = emptyCleanupReport();
    r.applied = true;
    expect(healthReport(r)[0]).toEqual({ tone: "check", text: "Asnjë kapitull i gjetur: libri është një pjesë e vetme" });
    const off = emptyCleanupReport();
    off.notes = { footnotes: 2, endnotes: 0, dropped: 0 };
    expect(healthReport(off)).toEqual([{ tone: "ok", text: "2 shënime në fund të faqes, të ruajtura në fund të kapitullit të vet" }]);
    expect(healthReport(emptyCleanupReport())).toEqual([]);
  });
});
