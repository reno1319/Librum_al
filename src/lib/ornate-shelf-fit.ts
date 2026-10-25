// BOOKSTORE ORNATE SHELF (Renato 10-25, board "Option 1, refined"): type
// sizes for the real titles and authors written on the ornate spines.
// Each spine is a fixed width (a shelf SLOT, not a book), so a long word
// on a thin spine must shrink rather than break or overflow.
//
// Widths are estimated from character counts, because the server cannot
// measure text. The per-character widths below are deliberately
// generous averages for Libre Caslon Text (lower case ~0.5em, capitals
// ~0.7em, plus letter-spacing), so an estimate errs towards a smaller
// size, never an overflow. The CSS keeps a last resort for anything the
// estimate misses (hyphenation, then a break inside the word, for text
// across a spine; an ellipsis for the titles along it).
//
// SHELF-2 (Renato 10-25): every title now runs along its spine, bottom
// to top, so a word is never cut in the middle; authors stay as before.

export type FitOptions = {
  // Usable width of the box, in px at the shelf's own (unzoomed) scale.
  boxPx: number;
  // Average width of one character, in em, including letter-spacing.
  emPerChar: number;
  maxPx: number;
  minPx: number;
  // The most lines the text may take (the CSS clamps at this count):
  // the whole text must also fit in about that many lines.
  lines?: number;
};

// A wrapped line is rarely filled to the edge, so the line count only
// assumes 80% of each line is used.
const LINE_FILL = 0.8;

function clampPx(value: number, minPx: number, maxPx: number): number {
  return Math.round(Math.min(maxPx, Math.max(minPx, value)) * 100) / 100;
}

function longestWordLength(text: string): number {
  return Math.max(1, ...text.trim().split(/\s+/).map((word) => [...word].length));
}

// Text that wraps between words: the size at which its longest word
// fits on one line of the box.
export function fitWrappedPx(text: string, { boxPx, emPerChar, maxPx, minPx, lines }: FitOptions): number {
  const wordFit = boxPx / (longestWordLength(text) * emPerChar);
  const chars = Math.max(1, [...text.trim()].length);
  const linesFit = lines ? (lines * boxPx * LINE_FILL) / (chars * emPerChar) : Infinity;
  return clampPx(Math.min(wordFit, linesFit), minPx, maxPx);
}

export type VerticalOptions = {
  // Length of the band the title (and, on a thin spine, the author)
  // runs along, in px.
  lengthPx: number;
  // Width of that band across the spine, in px: room for the lines.
  widthPx: number;
  // Space between the title and the author, in px.
  gapPx: number;
  // Line height of the title, as a multiple of its size.
  lineHeight: number;
  // The most lines the title may take, side by side.
  maxLines: number;
  // emPerChar is a lower-case letter's width; with caps true the title
  // is set in capitals (CSS uppercase) and emPerChar is a capital's.
  title: { emPerChar: number; maxPx: number; minPx: number; caps?: boolean };
  // The author's type, when the author shares the band (thin spines).
  author?: { emPerChar: number; maxPx: number; minPx: number };
  // The most of the band the author may take, as a fraction.
  authorShare?: number;
};

export type VerticalFit = { titleLines: string[]; titlePx: number; authorPx: number; titleFits: boolean };

// A title fills fewer lines as long as it stays at least this share of
// its full size; past that it takes another line (Renato 10-25: a long
// title goes onto a second line, and only shrinks a little).
const COMFORT_SHARE = 0.75;

// How wide one character is, as a multiple of emPerChar (SHELF-2 audit
// F1: a title typed in capitals was estimated as lower case and cut).
// Mixed case: a capital is ~1.4 lower-case letters (Libre Caslon ~0.7em
// against ~0.5em), M and W ~1.75, lower-case m and w ~1.5. Set in
// capitals (emPerChar is already a capital's): M and W ~1.25. Spaces
// and everything else count as one, which errs towards a smaller size.
const WIDE_LETTERS = new Set(["M", "W"]);
export function charWeight(ch: string, caps = false): number {
  const upper = ch.toUpperCase();
  const isLetter = upper !== ch.toLowerCase();
  if (caps) return isLetter && WIDE_LETTERS.has(upper) ? 1.25 : 1;
  if (!isLetter) return 1;
  if (ch === upper) return WIDE_LETTERS.has(upper) ? 1.75 : 1.4;
  return WIDE_LETTERS.has(upper) ? 1.5 : 1;
}

// A line's estimated length, in multiples of emPerChar.
export function lineWeight(line: string, caps = false): number {
  return [...line].reduce((sum, ch) => sum + charWeight(ch, caps), 0);
}

// The longest line's estimated length.
function longestLine(lines: string[], caps = false): number {
  return Math.max(1, ...lines.map((line) => lineWeight(line, caps)));
}

// Splits a title between words into at most `count` lines, making the
// longest (estimated) line as short as possible. Titles are short, so every split
// is tried; a title of more than 24 words is simply cut into equal runs
// of words.
export function splitIntoLines(title: string, count: number, caps = false): string[] {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const n = Math.min(Math.max(1, count), Math.max(1, words.length));
  if (n === 1) return [words.join(" ")];
  if (words.length > 24) {
    const per = Math.ceil(words.length / n);
    return Array.from({ length: n }, (_, i) => words.slice(i * per, (i + 1) * per).join(" ")).filter(Boolean);
  }
  let best: string[] = [words.join(" ")];
  let bestLongest = Infinity;
  const walk = (start: number, linesLeft: number, acc: string[]) => {
    if (linesLeft === 1) {
      const lines = [...acc, words.slice(start).join(" ")];
      const longest = longestLine(lines, caps);
      if (longest < bestLongest) [best, bestLongest] = [lines, longest];
      return;
    }
    for (let end = start + 1; end <= words.length - (linesLeft - 1); end++) {
      walk(end, linesLeft - 1, [...acc, words.slice(start, end).join(" ")]);
    }
  };
  walk(0, n, []);
  return best;
}

// A title written along the spine, bottom to top, in one or more lines
// side by side, and (on a thin spine) the author after it on the same
// line of sight. The author takes what it needs up to its share of the
// band; the title the rest. The title keeps to one line while it can
// stay near its full size, else takes the fewest lines that let it,
// else the split that gives the largest size. titleFits is false when
// even that is under the floor, and the CSS ellipsis will cut it.
export function fitVertical(title: string, author: string | null, options: VerticalOptions): VerticalFit {
  const { lengthPx, widthPx, gapPx, lineHeight, maxLines } = options;
  const authorType = options.author;
  const authorChars = author && authorType ? [...author.trim()].length : 0;
  const authorPx =
    authorChars && authorType
      ? clampPx(
          (lengthPx * (options.authorShare ?? 0.4)) / (authorChars * authorType.emPerChar),
          authorType.minPx,
          authorType.maxPx,
        )
      : 0;
  const authorLengthPx = authorChars && authorType ? authorChars * authorType.emPerChar * authorPx + gapPx : 0;
  const room = lengthPx - authorLengthPx;
  const caps = options.title.caps ?? false;

  const sizeFor = (lines: string[]) =>
    Math.min(
      options.title.maxPx,
      room / (longestLine(lines, caps) * options.title.emPerChar),
      widthPx / (lines.length * lineHeight),
    );

  const comfort = options.title.maxPx * COMFORT_SHARE;
  let chosen: string[] = [title.trim()];
  let chosenSize = sizeFor(chosen);
  for (let count = 1; count <= maxLines; count++) {
    const lines = splitIntoLines(title, count, caps);
    if (lines.length < count) break;
    const size = sizeFor(lines);
    if (count === 1 || size > chosenSize) [chosen, chosenSize] = [lines, size];
    if (size >= comfort) {
      [chosen, chosenSize] = [lines, size];
      break;
    }
  }
  return {
    titleLines: chosen,
    titlePx: clampPx(chosenSize, options.title.minPx, options.title.maxPx),
    authorPx,
    titleFits: chosenSize >= options.title.minPx,
  };
}
