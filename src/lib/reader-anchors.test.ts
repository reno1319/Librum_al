import { describe, expect, it } from "vitest";
import {
  anchorFor,
  firstOffsetWhere,
  isHighlightColor,
  lastAtOrBefore,
  parseLocalPlace,
  progressLabel,
  progressOf,
  reanchor,
  serializeLocalPlace,
  serverPlaceWins,
  snapToWords,
} from "@/lib/reader-anchors";

const TEXT = "Era e veriut zbriste nga mali. Mësuesi i ri e kishte mësuar zërin e saj. Era e veriut u kthye.";

describe("snapToWords", () => {
  it("grows a drag to whole words and trims spaces, in either direction", () => {
    const a = TEXT.indexOf("veriut") + 2;
    const b = TEXT.indexOf("zbriste") + 3;
    expect(snapToWords(TEXT, a, b)).toEqual({ start: TEXT.indexOf("veriut"), end: TEXT.indexOf("zbriste") + "zbriste".length });
    expect(snapToWords(TEXT, b, a)).toEqual(snapToWords(TEXT, a, b));
  });
  it("a press with no drag takes the word under the finger (ë inside a word)", () => {
    const at = TEXT.indexOf("Mësuesi") + 3;
    const r = snapToWords(TEXT, at, at)!;
    expect(TEXT.slice(r.start, r.end)).toBe("Mësuesi");
  });
  it("only spaces give nothing", () => {
    expect(snapToWords("a    b", 2, 3)).toBeNull();
  });
});

describe("anchorFor / reanchor", () => {
  it("keeps the words and up to 32 characters around them", () => {
    const s = TEXT.indexOf("Mësuesi");
    const a = anchorFor(TEXT, s, s + 7)!;
    expect(a.quote).toBe("Mësuesi");
    expect(a.prefix).toBe(TEXT.slice(Math.max(0, s - 32), s));
    expect(a.suffix).toBe(TEXT.slice(s + 7, s + 39));
  });
  it("refuses an empty, blank or too-long span", () => {
    expect(anchorFor(TEXT, 5, 5)).toBeNull();
    expect(anchorFor("a   b", 1, 4)).toBeNull();
    expect(anchorFor("x".repeat(5000), 0, 4001)).toBeNull();
  });
  it("the same text: stays where it was", () => {
    const s = TEXT.indexOf("zërin");
    const a = anchorFor(TEXT, s, s + 5)!;
    expect(reanchor(TEXT, a)).toEqual({ start: s, end: s + 5 });
  });
  it("a changed version: finds the words where they moved", () => {
    const s = TEXT.indexOf("zërin");
    const a = anchorFor(TEXT, s, s + 5)!;
    const changed = "Një fjali e re në fillim. " + TEXT;
    expect(reanchor(changed, a)).toEqual({ start: s + 26, end: s + 31 });
  });
  it("words that appear twice: picks the one with the same text around it", () => {
    const second = TEXT.lastIndexOf("Era e veriut");
    const a = anchorFor(TEXT, second, second + 12)!;
    const changed = TEXT.replace("Mësuesi", "Mësuesi i vjetër");
    const r = reanchor(changed, a)!;
    expect(r.start).toBe(changed.lastIndexOf("Era e veriut"));
  });
  it("words that are gone: null (kept as changed, Q3 a)", () => {
    const s = TEXT.indexOf("zërin");
    const a = anchorFor(TEXT, s, s + 5)!;
    expect(reanchor(TEXT.replace("zërin", "këngën"), a)).toBeNull();
  });
});

describe("search helpers", () => {
  it("lastAtOrBefore", () => {
    expect(lastAtOrBefore([0, 10, 20], 15)).toBe(1);
    expect(lastAtOrBefore([0, 10, 20], 20)).toBe(2);
    expect(lastAtOrBefore([5], 1)).toBe(-1);
  });
  it("firstOffsetWhere", () => {
    expect(firstOffsetWhere(0, 100, (o) => o >= 37)).toBe(37);
    expect(firstOffsetWhere(0, 100, () => false)).toBe(101);
    expect(firstOffsetWhere(0, 100, () => true)).toBe(0);
  });
});

describe("progress", () => {
  it("is the share of the text, and 1 on the last page", () => {
    expect(progressOf(250, 1000, false)).toBe(0.25);
    expect(progressOf(10, 1000, true)).toBe(1);
    expect(progressOf(5, 0, false)).toBe(0);
  });
  it("the Biblioteka line", () => {
    expect(progressLabel(0.001)).toBe("1% e lexuar");
    expect(progressLabel(0.356)).toBe("35% e lexuar");
    expect(progressLabel(0.996)).toBe("Përfunduar");
    expect(progressLabel(1)).toBe("Përfunduar");
  });
  it("colours", () => {
    expect(isHighlightColor("pink")).toBe(true);
    expect(isHighlightColor("red")).toBe(false);
  });
});

describe("the place in this browser and sync (Q6 a)", () => {
  it("reads the old bare share and the new form, refuses junk", () => {
    expect(parseLocalPlace("0.4")).toEqual({ offset: null, progress: 0.4, synced: null });
    expect(parseLocalPlace("1.4")).toBeNull();
    expect(parseLocalPlace(serializeLocalPlace({ offset: 120, progress: 0.1, synced: "2026-11-15T10:00:00Z" }))).toEqual({
      offset: 120,
      progress: 0.1,
      synced: "2026-11-15T10:00:00Z",
    });
    expect(parseLocalPlace('{"o":-1,"p":0.1}')).toBeNull();
    expect(parseLocalPlace("{bad")).toBeNull();
    expect(parseLocalPlace(null)).toBeNull();
  });
  it("the server's place wins only when saved after this browser's last save", () => {
    const local = { offset: 10, progress: 0.1, synced: "2026-11-15T10:00:00Z" };
    expect(serverPlaceWins({ offset: 99, progress: 0.9, updatedAt: "2026-11-15T11:00:00Z" }, local)).toBe(true);
    expect(serverPlaceWins({ offset: 99, progress: 0.9, updatedAt: "2026-11-15T10:00:00Z" }, local)).toBe(false);
    expect(serverPlaceWins(null, local)).toBe(false);
    expect(serverPlaceWins({ offset: 99, progress: 0.9, updatedAt: "2026-11-15T09:00:00Z" }, null)).toBe(true);
  });
});
