import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isLeaderLine, stripLeaderTail } from "./docx-leader";
import { convertDocxToDocument } from "./docx-converter";
import { buildDocxBytes, fmt, heading, prose } from "./docx-test-fixtures";

// The two regexes docx-structure.ts used before, rebuilt from their exact
// source text on staging 364823097bf8 (escapes, not retyped characters: the
// old LINE counted NBSP in its 3+ spaces run, TAIL did not). The sha256
// test below proves the source text is byte-identical. They are only the
// reference answer, on short inputs where they are fast.
const OLD_LINE_RE = new RegExp(
  "^\\S.{0,150}?(?:[ \\t]*(?:\\.{2,}|\u2026+|\u00b7{2,}|_{2,})[ \\t.\u2026\u00b7_]*|\\t+[ \\t]*|[ \u00a0]{3,})(?:\\d{1,4}|[ivxlcdm]{1,6})$",
  "i",
);
const OLD_TAIL_RE = new RegExp(
  "(?:[ \\t]*(?:\\.{2,}|\u2026+|\u00b7{2,}|_{2,})[ \\t.\u2026\u00b7_]*|\\t+[ \\t]*|[\u0020\u0020]{3,})(?:\\d{1,4}|[ivxlcdm]{1,6})$",
  "i",
);
const OLD_LINE_SHA256 = "665b2e74b3de6a51ed63779881137227c9cb3f6497aba232a7e57387e24a48a3";
const OLD_TAIL_SHA256 = "6ddff4d62d71e9d287ba7f96e6f69663bc68c158a14d06431c1f902278584068";

// Small seeded generator so a failure is reproducible.
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

// Every character class the patterns care about, plus look-alikes that
// must NOT count (non-breaking space, dotless i, long s, Kelvin sign,
// line breaks, letters that are not Roman numerals, a lone surrogate).
const ALPHABET = [
  " ", " ", " ", "\t", "\t", ".", ".", ".", "…", "·", "·", "_", "_",
  "1", "2", "9", "0", "i", "v", "x", "I", "M", "c",
  "a", "K", "e", "ë", "-", "\u00a0", "\u00a0", "\u00a0", "\u0131", "\u017f", "\u212a", "\n", "\r", "\u2028", "\u2029", "\ufeff", "\ud800",
];

function randomString(next: () => number, maxLen: number): string {
  const len = Math.floor(next() * (maxLen + 1));
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(next() * ALPHABET.length)];
  return s;
}

function expectSameAsOld(s: string) {
  expect({ s, line: isLeaderLine(s) }).toEqual({ s, line: OLD_LINE_RE.test(s) });
  expect({ s, strip: stripLeaderTail(s) }).toEqual({ s, strip: s.replace(OLD_TAIL_RE, "") });
}

function ms(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

describe("contents-list leader matching: same answers as the old regexes", () => {
  it("the reference regexes are byte-identical to the old source", () => {
    const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
    expect(sha(OLD_LINE_RE.source)).toBe(OLD_LINE_SHA256);
    expect(sha(OLD_TAIL_RE.source)).toBe(OLD_TAIL_SHA256);
    expect(OLD_LINE_RE.flags).toBe("i");
    expect(OLD_TAIL_RE.flags).toBe("i");
  });

  it("normal contents lines", () => {
    const cases = [
      "Tregimi i parë ............ 3",
      "Tregimi i dytë\t17",
      "Tregimi i tretë ...... 29",
      "Hyrje … 5",
      "Hyrje…………5",
      "Pjesa e dytë ·········· 41",
      "Shënime ____ 120",
      "Parathënie    ix",
      "Parathënie\t\tXII",
      "Kapitulli 1 . . . . . 12",
      "Kapitulli 1 .. . . 12",
      "Fundi 12",
      "Fundi  12",
      "Fundi   12",
      "Fundi\u00a0\u00a0\u00a012",
      "Fundi .5",
      "Fundi ..12345",
      "Fundi ..mmmmmmm",
      "Fundi ..mmmmmm",
      "Viti 1999",
      "Ai erdhi në orën 10",
      "Shih faqen ... x1",
      ". .. 4",
      "... 4",
      "\t... 4",
      "",
      "A",
      "A...",
      "A..1",
      "A\n...1",
      "Kapitulli 1\u00a0\u00a0\u00a07",
      "Fundi\u00a0\u00a0\u00a0ix",
      "x\u00a0\u00a0\u00a012",
      "x \u00a0 12",
      "x\u00a0 12",
      "x \u00a012",
      "x\u00a0\u00a0 \t12",
      "\u00a0\u00a0\u00a012",
      "x\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0 ......12",
      "x ...\u00a0\u00a0\u00a012",
    ];
    for (const s of cases) expectSameAsOld(s);
  });

  it("the 150-character limit before the leader", () => {
    for (let len = 140; len <= 160; len++) {
      const title = "K" + "a".repeat(len - 1);
      for (const tail of [" .... 7", "\t7", "   7", "\u00a0\u00a0\u00a07", " \u00a0 7", "..7", " … iv"]) expectSameAsOld(title + tail);
      expectSameAsOld(title.slice(0, 20) + "\n" + title.slice(21) + " .... 7");
      expectSameAsOld(title.slice(0, 20) + "\u2028" + title.slice(21) + " .... 7");
    }
  });

  it("random short strings (seeded)", () => {
    for (const [seed, count, maxLen] of [
      [1, 40000, 10],
      [2, 20000, 16],
      [3, 5000, 24],
    ] as const) {
      const next = rng(seed);
      for (let k = 0; k < count; k++) {
        const s = randomString(next, maxLen);
        expectSameAsOld(s);
        // Contents-line shaped: a word, then random leader-ish text.
        expectSameAsOld("Kapitulli" + s);
      }
    }
  });
});

describe("contents-list leader matching: long runs stay fast (ReDoS)", () => {
  const LIMIT_MS = 250;
  const N = 50_000;
  const pathological = [
    "Fundi" + ".".repeat(5_000),
    "Fundi" + ".".repeat(N),
    "Fundi" + " ".repeat(N),
    " ".repeat(N),
    "Fundi" + "\t".repeat(N),
    "Fundi" + "…".repeat(N),
    "Fundi" + "·".repeat(N),
    "Fundi" + "_".repeat(N),
    "Fundi" + ". ".repeat(N / 2),
    "Fundi" + ".".repeat(N) + "12345",
    "Fundi" + ".".repeat(N) + "x1",
    "Fundi" + " ".repeat(N) + "-1",
    ".".repeat(N) + "a",
    "Fundi" + " .".repeat(N / 2) + "mmmmmmm",
  ];

  it.each(pathological.map((s, i) => [i, s] as const))("pathological input #%i finishes quickly", (_i, s) => {
    const elapsed = ms(() => {
      isLeaderLine(s);
      stripLeaderTail(s);
    });
    expect(elapsed).toBeLessThan(LIMIT_MS);
  });

  it("long runs still give the right answer", () => {
    expect(isLeaderLine("Fundi" + ".".repeat(N))).toBe(false);
    expect(isLeaderLine("Fundi" + " ".repeat(N))).toBe(false);
    expect(isLeaderLine("Fundi" + ".".repeat(N) + "12")).toBe(true);
    expect(isLeaderLine("Fundi" + " ".repeat(N) + "xii")).toBe(true);
    expect(stripLeaderTail("Fundi" + ".".repeat(N) + "12")).toBe("Fundi");
    expect(stripLeaderTail("Fundi" + ".".repeat(N) + "12345")).toBe("Fundi" + ".".repeat(N) + "12345");
  });

  it("a Word file with a 50,000-dot paragraph converts quickly and keeps the contents list rule", async () => {
    const bytes = await buildDocxBytes({
      bodyXml:
        fmt("Përmbajtja") + fmt("Tregimi i parë ............ 3") + fmt("Tregimi i dytë\u00a0\u00a0\u00a017") + fmt("Tregimi i tretë ...... 29") + prose("Dita") +
        heading(1, "Tregimi i parë") + prose("Nata") + fmt("Fundi" + ".".repeat(N)) + fmt(" ".repeat(N) + "Era") +
        heading(1, "Tregimi i dytë") + prose("Era") + heading(1, "Tregimi i tretë") + prose("Shiu"),
      includeStyles: true,
    });
    const t0 = performance.now();
    const r = await convertDocxToDocument(bytes);
    const elapsed = performance.now() - t0;
    if (!r.success) throw new Error(`conversion failed: ${r.error}`);
    expect(r.cleanup.fixes.contentsLinesRemoved).toBe(4);
    expect(r.sections.map((s) => s.heading)).toEqual([null, "Tregimi i parë", "Tregimi i dytë", "Tregimi i tretë"]);
    expect(elapsed).toBeLessThan(2_000);
  });
});
