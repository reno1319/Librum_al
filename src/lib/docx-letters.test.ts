import { afterEach, describe, expect, it, vi } from "vitest";
import { convertDocxToDocument } from "./docx-converter";
import { findMissingLetters, fixBrokenLetters, MISSING_LETTERS_MIN_WORDS, MISSING_LETTERS_THRESHOLD } from "./docx-letters";
import { buildDocxBytes, heading, paragraph } from "./docx-test-fixtures";

// W3 Part 2: broken letters fixed (answer 6a), missing ë/ç reported only
// (answer 5a). All text is invented.

afterEach(() => {
  vi.unstubAllEnvs();
});

async function convert(bodyXml: string) {
  const r = await convertDocxToDocument(await buildDocxBytes({ bodyXml, includeStyles: true }));
  if (!r.success) throw new Error("conversion failed");
  return r;
}

describe("broken letters (answer 6a)", () => {
  it("fixes UTF-8 text read as Windows 'Western' and counts every fix", () => {
    expect(fixBrokenLetters("NjÃ« Ã§ast, Ã‹shtÃ« Ã‡ka â€œthaâ€\u009D â€˜poâ€™ â€žmirÃ«â€œ â€“ â€” â€¦ Â«poÂ»")).toEqual({
      text: "Një çast, Është Çka “tha” ‘po’ „mirë“ – — … «po»",
      count: 17,
    });
    expect(fixBrokenLetters("Ã\u008Bshtë Ã\u0087ka")).toEqual({ text: "Është Çka", count: 2 });
  });

  it("leaves correct Albanian text, and lone Ã or â, untouched", () => {
    const text = "Është një çast. „Po“, tha ajo — «jo». São Paulo, Ãngel, â la carte.";
    expect(fixBrokenLetters(text)).toEqual({ text, count: 0 });
  });

  it("fixes them in the book, the chapter title included, and not on Production", async () => {
    const body = heading(1, "Kreu i parÃ«") + paragraph("Ajo Ã«shtÃ« kÃ«tu.");
    const r = await convert(body);
    expect(r.sections[0].heading).toBe("Kreu i parë");
    expect(r.sections[0].html).toBe("<p>Ajo është këtu.</p>");
    expect(r.cleanup.fixes.brokenLetters).toBe(4);
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    const prod = await convert(body);
    expect(prod.sections[0].html).toBe("<p>Ajo Ã«shtÃ« kÃ«tu.</p>");
    expect(prod.cleanup.fixes.brokenLetters).toBe(0);
  });
});

describe("missing ë/ç (answer 5a)", () => {
  const typed = (n: number) => Array.from({ length: n }, (_, i) => (i % 3 === 0 ? "Eshte" : i % 3 === 1 ? "nje" : "per")).join(" ");

  it("says nothing below 20 such words, and reports the top words from 20 on", () => {
    expect(findMissingLetters([typed(MISSING_LETTERS_THRESHOLD - 1)])).toBeNull();
    const r = findMissingLetters([typed(MISSING_LETTERS_THRESHOLD), "cdo cfare keshtu shume ketu"]);
    expect(r!.total).toBe(25);
    expect(r!.words).toHaveLength(5);
    expect(r!.words[0]).toEqual({ word: "eshte", correct: "është", count: 7 });
    expect(r!.words.map((w) => w.word)).toEqual(["eshte", "nje", "per", "cdo", "cfare"]);
  });

  it("never flags correct text or words that are right without dots", () => {
    const correct = "Është një ditë për çdo gjë. Cili ishte ai? Edhe ne, te shtëpia, kështu shumë herë. Jane erdhi. ".repeat(30);
    expect(findMissingLetters([correct])).toBeNull();
  });

  // Renato's audit answer Q2a (31 Oct): "per" is a normal English and
  // Italian word, so one list word alone, however often, says nothing.
  it("needs at least 3 different words: 'per' alone in an English or Italian book never warns", () => {
    expect(MISSING_LETTERS_MIN_WORDS).toBe(3);
    expect(findMissingLetters([Array.from({ length: 50 }, () => "per").join(" ")])).toBeNull();
    expect(findMissingLetters(["The fee was paid per day, per person. ".repeat(25), "Grazie per tutto, per sempre. ".repeat(25)])).toBeNull();
    expect(findMissingLetters([`${"per nje ".repeat(15)}`])).toBeNull();
    const three = findMissingLetters([`${"per nje ".repeat(15)} eshte`]);
    expect(three).toMatchObject({ total: 31 });
    expect(three!.words.map((w) => w.word)).toEqual(["nje", "per", "eshte"]);
  });

  it("reports in the book but never changes the text", async () => {
    const r = await convert(heading(1, "Kreu") + paragraph(`${typed(21)}.`));
    expect(r.cleanup.missingLetters).toMatchObject({ total: 21 });
    expect(r.sections[0].html).toContain("Eshte nje per");
  });
});
