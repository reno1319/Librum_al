import { describe, expect, it } from "vitest";
import { charWeight, fitVertical, fitWrappedPx, lineWeight, splitIntoLines, type VerticalOptions } from "./ornate-shelf-fit";

const WRAP = { boxPx: 54, emPerChar: 0.76, maxPx: 9.5, minPx: 7 };
const SIDEWAYS: VerticalOptions = {
  lengthPx: 255,
  widthPx: 48,
  gapPx: 12,
  lineHeight: 1.1,
  maxLines: 2,
  title: { emPerChar: 0.52, maxPx: 16, minPx: 7 },
  author: { emPerChar: 0.9, maxPx: 10, minPx: 7 },
  authorShare: 0.4,
};
const WIDE: VerticalOptions = {
  lengthPx: 220,
  widthPx: 50,
  gapPx: 0,
  lineHeight: 1.15,
  maxLines: 3,
  title: { emPerChar: 0.76, maxPx: 14, minPx: 6 },
};

describe("fitWrappedPx", () => {
  it("keeps the full size when the longest word fits", () => {
    expect(fitWrappedPx("Kopshti i Bardhë", WRAP)).toBe(9.5);
  });

  it("shrinks so the longest word fits the box on one line", () => {
    const px = fitWrappedPx("Shqipëria", WRAP);
    expect(9 * 0.76 * px).toBeLessThanOrEqual(54);
    expect(px).toBeLessThan(9.5);
  });

  it("never goes below the floor, and counts letters, not bytes", () => {
    expect(fitWrappedPx("Mirëmëngjesishqipëtarëve", WRAP)).toBe(7);
    expect(fitWrappedPx("ëëëëëëë", WRAP)).toBe(fitWrappedPx("eeeeeee", WRAP));
  });

  it("with a line count, a long text also shrinks to fit about that many lines", () => {
    const text = "Besnik Kola Marku";
    const free = fitWrappedPx(text, { boxPx: 80, emPerChar: 0.86, maxPx: 10, minPx: 7 });
    const two = fitWrappedPx(text, { boxPx: 80, emPerChar: 0.86, maxPx: 10, minPx: 7, lines: 2 });
    expect(free).toBe(10);
    expect(two).toBeLessThan(10);
    expect(text.length * 0.86 * two).toBeLessThanOrEqual(2 * 80 * 0.8 + 0.5);
  });

  it("treats empty or space-only text as one short word", () => {
    expect(fitWrappedPx("  ", WRAP)).toBe(9.5);
  });
});

describe("splitIntoLines", () => {
  it("keeps one line, or splits between words making the longest line as short as possible", () => {
    expect(splitIntoLines("Drita e Veriut", 1)).toEqual(["Drita e Veriut"]);
    expect(splitIntoLines("Historia e paparashikueshme e familjes sonë", 2)).toEqual([
      "Historia e paparashikueshme",
      "e familjes sonë",
    ]);
    expect(splitIntoLines("Në kërkim të kohës së humbur në Tiranë", 3)).toEqual([
      "Në kërkim të",
      "kohës së humbur",
      "në Tiranë",
    ]);
  });

  it("never splits inside a word, and gives no more lines than words", () => {
    expect(splitIntoLines("Zemërthyerja", 3)).toEqual(["Zemërthyerja"]);
    expect(splitIntoLines("Kënga e", 3)).toEqual(["Kënga", "e"]);
    const many = Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ");
    const lines = splitIntoLines(many, 3);
    expect(lines).toHaveLength(3);
    expect(lines.join(" ")).toBe(many);
  });
});

describe("fitVertical", () => {
  it("the board's own example keeps the board's sizes on one line", () => {
    const fit = fitVertical("Drita e Veriut", "Elira Dushku", SIDEWAYS);
    expect(fit.titleLines).toEqual(["Drita e Veriut"]);
    expect(fit.titlePx).toBe(16);
    expect(fit.titleFits).toBe(true);
    expect(fit.authorPx).toBeGreaterThan(9);
  });

  it("a long title takes a second line before it shrinks far (Renato 1a)", () => {
    const title = "Historia e paparashikueshme e familjes sonë";
    const fit = fitVertical(title, "Elira Dushku", SIDEWAYS);
    expect(fit.titleLines).toHaveLength(2);
    expect(fit.titleFits).toBe(true);
    expect(fit.titlePx).toBeGreaterThan(fitVertical(title, "Elira Dushku", { ...SIDEWAYS, maxLines: 1 }).titlePx);
  });

  it("lines never overflow the band: length along it, and width across it", () => {
    for (const title of ["Kujtimet e një dimri të gjatë në malësi", "Pride and Prejudice", "A", "Crime and Punishment"]) {
      const fit = fitVertical(title, null, WIDE);
      const longest = Math.max(...fit.titleLines.map((l) => [...l].length));
      expect(longest * WIDE.title.emPerChar * fit.titlePx).toBeLessThanOrEqual(WIDE.lengthPx + 0.5);
      expect(fit.titleLines.length * WIDE.lineHeight * fit.titlePx).toBeLessThanOrEqual(WIDE.widthPx + 0.5);
    }
  });

  it("a short title on a wide spine stays one line at full size", () => {
    expect(fitVertical("Dracula", null, WIDE)).toEqual({ titleLines: ["Dracula"], titlePx: 14, authorPx: 0, titleFits: true });
  });

  it("an unbreakable very long title stops at the floor and reports that it will be cut", () => {
    const fit = fitVertical("A".repeat(80), "Author", SIDEWAYS);
    expect(fit.titleLines).toEqual(["A".repeat(80)]);
    expect(fit.titlePx).toBe(7);
    expect(fit.titleFits).toBe(false);
  });

  it("a long author takes at most its share of the band; no author leaves the band to the title", () => {
    expect(fitVertical("Deti", "Anastasia Konstantinopulli-Gjergjaj", SIDEWAYS).authorPx).toBe(7);
    expect(fitVertical("Deti", "Ana Kola", SIDEWAYS).authorPx).toBe(10);
    const none = fitVertical("Drita e Veriut e Largët", null, SIDEWAYS);
    expect(none.authorPx).toBe(0);
    expect(none.titlePx).toBe(16);
  });
});

// SHELF-2 audit F1: capitals are wider than lower case, so a title
// typed in capitals must be estimated as capitals.
describe("charWeight / lineWeight", () => {
  it("weighs capitals and wide letters more than lower case", () => {
    expect(charWeight("a")).toBe(1);
    expect(charWeight("A")).toBe(1.4);
    expect(charWeight("Ë")).toBe(1.4);
    expect(charWeight("M")).toBe(1.75);
    expect(charWeight("w")).toBe(1.5);
    expect(charWeight(" ")).toBe(1);
    expect(charWeight("7")).toBe(1);
  });

  it("set in capitals, every letter is a capital and only M and W are wider", () => {
    expect(charWeight("a", true)).toBe(1);
    expect(charWeight("m", true)).toBe(1.25);
    expect(lineWeight("Mal", true)).toBe(3.25);
    expect(lineWeight("DRITA")).toBeCloseTo(7);
    expect(lineWeight("drita")).toBe(5);
  });

  it("a spine set in capitals does not count a typed capital twice", () => {
    const long = "Mjegulla Mbi Malet e Moravës";
    const asCaps = fitVertical(long, null, { ...WIDE, maxLines: 1, title: { ...WIDE.title, caps: true } });
    const asMixed = fitVertical(long, null, { ...WIDE, maxLines: 1 });
    expect(asCaps.titlePx).toBeGreaterThan(asMixed.titlePx);
  });

  it("splits a caps title by its weighted length", () => {
    expect(splitIntoLines("MMMM a b c d e f g", 2).map((l) => l.length)).toEqual([6, 11]);
    // by plain character count the split would be "MMMM a b" / "c d e f g"
    expect(splitIntoLines("mmmm a b c d e f g", 2)).toEqual(["mmmm a b", "c d e f g"]);
  });
});

describe("fitVertical: the width cap", () => {
  it("lines never get wider than the band across the spine", () => {
    const fit = fitVertical("Dracula", null, { ...WIDE, widthPx: 10 });
    expect(fit.titlePx).toBeCloseTo(10 / 1.15, 1);
    const three = fitVertical("Kujtimet e një dimri të gjatë në malësi", null, { ...WIDE, widthPx: 30, maxLines: 3 });
    expect(three.titleLines.length * WIDE.lineHeight * three.titlePx).toBeLessThanOrEqual(30.5);
  });
});

