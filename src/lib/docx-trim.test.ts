import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { convertDocxToDocument } from "./docx-converter";
import { trimSpace, trimSpaceEnd } from "./docx-trim";
import { buildDocxBytes, fmt, heading, prose } from "./docx-test-fixtures";

// The two regexes docx-paragraphs.ts used before, rebuilt from their exact
// source text on staging a2e2aad6 (the sha256 test proves it). They are
// only the reference answer, on short inputs where they are fast.
const OLD_TRIM_RE = new RegExp("^[\\s\u00a0\u200b\ufeff]+|[\\s\u00a0\u200b\ufeff]+$", "g");
const OLD_TRAIL_RE = new RegExp("[\\s\u00a0\u200b\ufeff]+$");
const OLD_TRIM_SHA256 = "df52feda86eacb0718347670f3ee4f833e2bbf1486fe129584eb0d2609799072";
const OLD_TRAIL_SHA256 = "51fb96a297435bf9ea0705bd4b33de04b4555f1b22fab9737b7b93ccc24db145";

function rng(seed: number) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Everything \s covers, the three extra characters, and look-alikes that
// are NOT trimmed (zero-width joiner, word joiner, U+180E, a lone surrogate).
const ALPHABET = [
  " ", " ", "\t", "\n", "\r", "\v", "\f", "\u00a0", "\u00a0", "\u200b", "\u200b", "\ufeff", "\ufeff",
  "\u1680", "\u2000", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000",
  "\u200c", "\u200d", "\u2060", "\u180e", "\ud800",
  "a", "ë", "1", ".", "-",
];

function expectSameAsOld(s: string) {
  expect({ s, trim: trimSpace(s) }).toEqual({ s, trim: s.replace(OLD_TRIM_RE, "") });
  expect({ s, end: trimSpaceEnd(s) }).toEqual({ s, end: s.replace(OLD_TRAIL_RE, "") });
}

describe("paragraph trimming: same output as the old regexes", () => {
  it("the reference regexes are byte-identical to the old source", () => {
    const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
    expect(sha(OLD_TRIM_RE.source)).toBe(OLD_TRIM_SHA256);
    expect(sha(OLD_TRAIL_RE.source)).toBe(OLD_TRAIL_SHA256);
    expect(OLD_TRIM_RE.flags).toBe("g");
    expect(OLD_TRAIL_RE.flags).toBe("");
  });

  it("normal and edge cases", () => {
    for (const s of ["", " ", "\u00a0\u200b\ufeff", "Fjala", "  Fjala  ", "\tFjala\u00a0", "\ufeffFjala\u200b", "a b", " a \u00a0 b ", "\u200dFjala\u200d", "a\u3000"]) {
      expectSameAsOld(s);
    }
  });

  it("random short strings (seeded)", () => {
    const next = rng(7);
    for (let k = 0; k < 60000; k++) {
      const len = Math.floor(next() * 13);
      let s = "";
      for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
      expectSameAsOld(s);
    }
  });
});

describe("paragraph trimming: long whitespace runs stay fast (ReDoS)", () => {
  const N = 100_000;
  const pathological = [
    "x" + " ".repeat(N) + "y",
    "x" + "\u00a0".repeat(N) + "y",
    "x" + "\u200b".repeat(N) + "y",
    "x" + "\t\n".repeat(N / 2) + "y",
    " ".repeat(N),
    "x" + " ".repeat(N),
    " ".repeat(N) + "y",
  ];
  it.each(pathological.map((s, i) => [i, s] as const))("pathological input #%i finishes quickly", (_i, s) => {
    const t0 = performance.now();
    trimSpace(s);
    trimSpaceEnd(s);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it("a Word file with a 100,000-space gap inside a paragraph converts quickly", async () => {
    const bytes = await buildDocxBytes({
      bodyXml:
        heading(1, "Tregimi i parë") + prose("Nata") + fmt("x" + " ".repeat(N) + "y") + fmt("z" + "\u00a0".repeat(N) + "w ") +
        heading(1, "Tregimi i dytë") + prose("Era"),
      includeStyles: true,
    });
    const t0 = performance.now();
    const r = await convertDocxToDocument(bytes);
    const elapsed = performance.now() - t0;
    if (!r.success) throw new Error(`conversion failed: ${r.error}`);
    expect(r.sections.map((s) => s.heading)).toEqual(["Tregimi i parë", "Tregimi i dytë"]);
    expect(elapsed).toBeLessThan(2_000);
  });
});
