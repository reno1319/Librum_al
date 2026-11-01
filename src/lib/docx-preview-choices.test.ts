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
    // An unsure typed contents list the pass kept: there is no "remove it" option.
    expect(canToggleGuess(guess({ kind: "typed_contents", applied: false }), applied)).toBe(false);
    // But one the author kept can be removed again.
    expect(canToggleGuess(guess({ kind: "typed_contents", applied: false }), { ...applied, keepContents: [7] })).toBe(true);
    // BD3 patch 2: a typed title page is offered for removal.
    expect(canToggleGuess(guess({ kind: "title_page", applied: false }), applied)).toBe(true);
  });
});

describe("undo of a removed copyright page or title page (BD3 patch 2)", () => {
  it("toggles keepCopyright and removeTitlePage, and accepts them from the browser", () => {
    const applied = emptyChoices();
    expect(toggleGuess(guess({ kind: "copyright_page" }), applied, applied).keepCopyright).toEqual([7]);
    expect(toggleGuess(guess({ kind: "title_page", applied: false }), applied, applied).removeTitlePage).toEqual([7]);
    expect(canToggleGuess(guess({ kind: "copyright_page", applied: false }), applied)).toBe(false);
    expect(canToggleGuess(guess({ kind: "copyright_page", applied: false }), { ...applied, keepCopyright: [7] })).toBe(true);
    expect(normalizeChoices({ keepCopyright: [3, 3, 1], removeTitlePage: [0] })).toMatchObject({ keepCopyright: [1, 3], removeTitlePage: [0] });
    expect(normalizeChoices({ keepCopyright: [-1] })).toBeNull();
  });

  it("counts the removed lines in the summary", () => {
    const r = emptyCleanupReport();
    r.applied = true;
    r.fixes.frontLinesRemoved = 1;
    expect(describeFixes(r)).toContain("1 rresht i faqes së të drejtave ose të titullit i hequr (Librum shton faqen e vet)");
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
    expect(describeGuess(guess({}), true, true)).toEqual({ state: "Fillim kapitulli: “Liqeni”", action: "Hiqe si kapitull", unsure: false });
    expect(describeGuess(guess({ confidence: "medium" }), false, true).action).toBe("Bëje kapitull");
    expect(describeGuess(guess({ confidence: "medium" }), false, true).unsure).toBe(true);
    expect(describeGuess(guess({}), true, false).action).toBeNull();
  });

  it("describes the typed contents and scene-break guesses in the checked wording", () => {
    const contents = guess({ kind: "typed_contents", text: "Përmbajtja" });
    expect(describeGuess(contents, true, true).state).toBe("Përmbajtja e shkruar nga ju, që fillon me “Përmbajtja”, u hoq. Librum e krijon vetë përmbajtjen e e-librit.");
    expect(describeGuess(contents, false, true).state).toBe("Përmbajtja e shkruar nga ju mbetet në libër: “Përmbajtja”");
    expect(describeGuess(guess({ kind: "scene_break" }), false, true).action).toBe("Shto një ndarje skene");
  });

  it("describes the removed copyright page and title page, with an undo (BD3 patch 2, 1a)", () => {
    const cp = guess({ kind: "copyright_page", text: "© 2020 Autor Prove / ISBN 978" });
    expect(describeGuess(cp, true, true)).toEqual({
      state: "Faqja e të drejtave u hoq: “© 2020 Autor Prove / ISBN 978”. Librum shton vetë faqen e të drejtave në çdo shkarkim.",
      action: "Kjo nuk është faqe të drejtash",
      unsure: false,
    });
    expect(describeGuess(cp, false, true).action).toBe("Hiqe");
    const tp = guess({ kind: "title_page", text: "LIBRI / Autor" });
    expect(describeGuess(tp, true, true).action).toBe("Ktheje në libër");
    expect(describeGuess(tp, false, true)).toEqual({
      state: "Titulli i shkruar në dokument mbetet në libër: “LIBRI / Autor”. Librum shton vetë faqen e parë me titullin dhe autorin, ndaj mund ta hiqni.",
      action: "Hiqe",
      unsure: false,
    });
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
      { tone: "ok", text: "53 shënime në fund të faqes, të ruajtura në fund të kapitullit përkatës" },
      { tone: "ok", text: "2 shënime në fund të librit, të ruajtura në kapitullin “Shënime”" },
      { tone: "ok", text: "4 hapësira boshe të ruajtura në rreshtat e vendosur në qendër dhe në poezi" },
      { tone: "ok", text: "3 shkronja të rregulluara (p.sh. “Ã«” në “ë”)" },
      { tone: "ok", text: "2 thonjëza të rregulluara" },
      { tone: "check", text: "1 rast ku Librum kërkon vëmendjen tuaj: shikoje te “Kontrolloni këto”" },
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
    expect(healthReport(off)).toEqual([{ tone: "ok", text: "2 shënime në fund të faqes, të ruajtura në fund të kapitullit përkatës" }]);
    expect(healthReport(emptyCleanupReport())).toEqual([]);
  });
});

describe("singular and plural counts (native check, 1 Nov)", () => {
  const all = (n: number, source: "detected" | "styles") => {
    const r = emptyCleanupReport();
    r.applied = true;
    r.chapters = n;
    r.chapterSource = source;
    r.subheadings = n;
    r.sceneBreaks = n;
    r.notes = { footnotes: n, endnotes: n, dropped: 0 };
    r.gaps = n;
    r.fixes.brokenLetters = n;
    r.fixes.contentsLinesRemoved = n;
    r.fixes.emptyLinesRemoved = n;
    r.fixes.indentsRemoved = n;
    r.fixes.paragraphsSplit = n;
    r.fixes.quotes = n;
    r.fixes.apostrophes = n;
    r.fixes.ellipses = n;
    r.fixes.dashes = n;
    r.fixes.dropCapsJoined = n;
    r.fixes.headingNumbersAdded = n;
    r.guesses = Array.from({ length: n }, (_, i) => guess({ confidence: "medium", paragraph: i + 1 }));
    r.missingLetters = { total: n, words: [{ word: "eshte", correct: "është", count: n }] };
    return healthReport(r).map((l) => l.text);
  };

  it("uses the singular words when N is 1", () => {
    expect(all(1, "detected")).toEqual([
      "1 kapitull i gjetur nga Librum",
      "1 shënim në fund të faqes, i ruajtur në fund të kapitullit përkatës",
      "1 shënim në fund të librit, i ruajtur në kapitullin “Shënime”",
      "1 hapësirë boshe e ruajtur në rreshtat e vendosur në qendër dhe në poezi",
      "1 shkronjë e rregulluar (p.sh. “Ã«” në “ë”)",
      "1 nëntitull",
      "1 ndarje skene (* * *)",
      "1 rresht i tabelës së përmbajtjes i hequr (Librum e krijon vetë përmbajtjen)",
      "1 rresht bosh i hequr",
      "1 kryeradhë me hapësira ose Tab e hequr",
      "1 paragraf i ndarë (rreshta të krijuar me Shift+Enter)",
      "1 thonjëz e rregulluar",
      "1 apostrof i rregulluar",
      "1 tre pika të rregulluara në …",
      "1 vizë e rregulluar",
      "1 shkronjë fillestare e madhe e bashkuar me fjalën",
      "1 numër titulli i ruajtur nga Word-i",
      "1 rast ku Librum kërkon vëmendjen tuaj: shikoje te “Kontrolloni këto”",
      "1 fjalë duket e shkruar pa ë ose ç: “eshte” (1) në vend të “është”. Librum nuk e ndryshon vetë; rregullojeni në Word dhe ngarkojeni dokumentin sërish.",
    ]);
    expect(all(1, "styles")[0]).toBe("1 kapitull nga llojet e Heading të Word-it");
  });

  it("uses the plural words from 2 up", () => {
    expect(all(2, "detected")).toEqual([
      "2 kapituj të gjetur nga Librum",
      "2 shënime në fund të faqes, të ruajtura në fund të kapitullit përkatës",
      "2 shënime në fund të librit, të ruajtura në kapitullin “Shënime”",
      "2 hapësira boshe të ruajtura në rreshtat e vendosur në qendër dhe në poezi",
      "2 shkronja të rregulluara (p.sh. “Ã«” në “ë”)",
      "2 nëntituj",
      "2 ndarje skenash (* * *)",
      "2 rreshta të tabelës së përmbajtjes të hequr (Librum e krijon vetë përmbajtjen)",
      "2 rreshta bosh të hequr",
      "2 kryeradhë me hapësira ose Tab të hequra",
      "2 paragrafë të ndarë (rreshta të krijuar me Shift+Enter)",
      "2 thonjëza të rregulluara",
      "2 apostrofa të rregulluara",
      "2 tre pika të rregulluara në …",
      "2 viza të rregulluara",
      "2 shkronja fillestare të mëdha të bashkuara me fjalën",
      "2 numra titujsh të ruajtur nga Word-i",
      "2 raste ku Librum kërkon vëmendjen tuaj: shikoji te “Kontrolloni këto”",
      "2 fjalë duken të shkruara pa ë ose ç: “eshte” (2) në vend të “është”. Librum nuk i ndryshon vetë; rregullojini në Word dhe ngarkojeni dokumentin sërish.",
    ]);
    expect(all(2, "styles")[0]).toBe("2 kapituj nga llojet e Heading të Word-it");
    expect(all(11, "detected")[0]).toBe("11 kapituj të gjetur nga Librum");
  });
});
