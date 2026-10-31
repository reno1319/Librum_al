// W3 Part 2: Albanian letters (Renato's answers 31 Oct, 5a and 6a).
//
// 1. Broken letters: text that was once UTF-8 but was read as Windows
//    "Western" somewhere on the way (a pasted web page, an old file)
//    shows "Ã«" for "ë" and "â€œ" for "“". These sequences never occur
//    in real Albanian text, so they are fixed automatically (6a) and
//    counted for the author's report.
// 2. Missing ë/ç: "eshte", "nje", "per" typed without the dots. This is
//    only reported, never corrected (5a): it counts very common words
//    whose plain-letter form is not an Albanian word, and the author is
//    told only when it looks like a habit (20 or more in the book, of at
//    least 3 different words).

// Longest sequences first is not needed: no key is a prefix of another.
const BROKEN: [string, string][] = [
  ["Ã«", "ë"],
  ["Ã‹", "Ë"],
  ["Ã\u008B", "Ë"],
  ["Ã§", "ç"],
  ["Ã‡", "Ç"],
  ["Ã\u0087", "Ç"],
  ["â€œ", "“"],
  ["â€\u009D", "”"],
  ["â€˜", "‘"],
  ["â€™", "’"],
  ["â€ž", "„"],
  ["â€“", "–"],
  ["â€”", "—"],
  ["â€¦", "…"],
  ["Â«", "«"],
  ["Â»", "»"],
];
const BROKEN_RE = new RegExp(BROKEN.map(([k]) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
const BROKEN_MAP = new Map(BROKEN);

export function fixBrokenLetters(text: string): { text: string; count: number } {
  let count = 0;
  const out = text.replace(BROKEN_RE, (m) => {
    count++;
    return BROKEN_MAP.get(m)!;
  });
  return { text: out, count };
}

// Plain-letter form -> the correct word. Only words whose plain form is
// not itself a word (so "cili", "edhe", "ne", "te" are not here), and
// not common English words or names.
const MISSING: Record<string, string> = {
  eshte: "është",
  nje: "një",
  per: "për",
  cdo: "çdo",
  keshtu: "kështu",
  shume: "shumë",
  ketu: "këtu",
  atehere: "atëherë",
  gjithe: "gjithë",
  tjeter: "tjetër",
  keto: "këto",
  kete: "këtë",
  dicka: "diçka",
  cfare: "çfarë",
  ceshtje: "çështje",
  behet: "bëhet",
  bere: "bërë",
  thene: "thënë",
  ndermjet: "ndërmjet",
  perse: "përse",
  perpara: "përpara",
  gjate: "gjatë",
  gje: "gjë",
  menyre: "mënyrë",
  femije: "fëmijë",
  shtepi: "shtëpi",
  shtepia: "shtëpia",
  gjuhe: "gjuhë",
  fjale: "fjalë",
  kohe: "kohë",
  nese: "nëse",
  zemer: "zemër",
};

export const MISSING_LETTERS_THRESHOLD = 20;
// At least this many different list words (Renato's audit answer Q2a,
// 31 Oct): "per" alone is a normal English and Italian word, while a
// real Albanian habit always hits several (nje, eshte, per...).
export const MISSING_LETTERS_MIN_WORDS = 3;
export const MISSING_LETTERS_SHOWN = 5;

export type MissingLetters = {
  total: number;
  words: { word: string; correct: string; count: number }[];
};

// `texts`: the book's plain text (no markup). Null when below the
// threshold or with fewer than 3 different words.
export function findMissingLetters(texts: string[]): MissingLetters | null {
  const counts = new Map<string, number>();
  let total = 0;
  for (const text of texts) {
    for (const m of text.normalize("NFC").matchAll(/\p{L}+/gu)) {
      const w = m[0].toLocaleLowerCase("sq");
      if (!Object.prototype.hasOwnProperty.call(MISSING, w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
      total++;
    }
  }
  if (total < MISSING_LETTERS_THRESHOLD || counts.size < MISSING_LETTERS_MIN_WORDS) return null;
  const words = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MISSING_LETTERS_SHOWN)
    .map(([word, count]) => ({ word, correct: MISSING[word], count }));
  return { total, words };
}
