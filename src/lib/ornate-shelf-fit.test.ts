import { describe, expect, it } from "vitest";
import { fitSideways, fitWrappedPx, type SidewaysOptions } from "./ornate-shelf-fit";

const WRAP = { boxPx: 54, emPerChar: 0.76, maxPx: 9.5, minPx: 7 };
const SIDEWAYS: SidewaysOptions = {
  lengthPx: 255,
  gapPx: 12,
  title: { emPerChar: 0.52, maxPx: 16, minPx: 10 },
  author: { emPerChar: 0.9, maxPx: 10, minPx: 7 },
  authorShare: 0.4,
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

describe("fitSideways", () => {
  it("the board's own example keeps the board's sizes", () => {
    const fit = fitSideways("Drita e Veriut", "Elira Dushku", SIDEWAYS);
    expect(fit.titlePx).toBe(16);
    expect(fit.titleFits).toBe(true);
    expect(fit.authorPx).toBeGreaterThan(9);
  });

  it("a long title shrinks so title and author together fit the band", () => {
    const title = "Kujtimet e një vere";
    const author = "Elira Dushku";
    const fit = fitSideways(title, author, SIDEWAYS);
    expect(fit.titleFits).toBe(true);
    const used = title.length * 0.52 * fit.titlePx + author.length * 0.9 * fit.authorPx + 12;
    expect(used).toBeLessThanOrEqual(255.5);
    expect(fit.titlePx).toBeLessThan(16);
  });

  it("a title too long for one line is split in two at the space nearest its middle", () => {
    const fit = fitSideways("Historia e paparashikueshme e familjes sonë", "Elira Dushku", SIDEWAYS);
    expect(fit.titleLines).toEqual(["Historia e paparashikueshme", "e familjes sonë"]);
    expect(fit.titleFits).toBe(true);
    expect(fit.titlePx).toBeGreaterThanOrEqual(10);
  });

  it("a title that fits on one line is never split", () => {
    expect(fitSideways("Drita e Veriut", "Elira Dushku", SIDEWAYS).titleLines).toEqual(["Drita e Veriut"]);
  });

  it("a very long title stops at the floor and reports that it will be cut", () => {
    const fit = fitSideways("A".repeat(80), "Author", SIDEWAYS);
    expect(fit.titleLines).toEqual(["A".repeat(80)]);
    expect(fit.titlePx).toBe(10);
    expect(fit.titleFits).toBe(false);
    expect(fitSideways(`${"A".repeat(60)} ${"B".repeat(60)}`, null, SIDEWAYS).titleFits).toBe(false);
  });

  it("a long author takes at most its share of the band", () => {
    const author = "Anastasia Konstantinopulli-Gjergjaj";
    const fit = fitSideways("Deti", author, SIDEWAYS);
    expect(fit.authorPx).toBe(7);
    const short = fitSideways("Deti", "Ana Kola", SIDEWAYS);
    expect(short.authorPx).toBe(10);
  });

  it("no author leaves the whole band to the title", () => {
    const fit = fitSideways("Drita e Veriut e Largët", null, SIDEWAYS);
    expect(fit.authorPx).toBe(0);
    expect(fit.titlePx).toBe(16);
  });
});
