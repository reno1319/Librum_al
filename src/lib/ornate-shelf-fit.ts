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
// estimate misses (hyphenation, then a break inside the word; an
// ellipsis on the sideways spines).

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

export type SidewaysOptions = {
  // Length of the band the title and author share, in px.
  lengthPx: number;
  // Space between the title and the author, in px.
  gapPx: number;
  title: { emPerChar: number; maxPx: number; minPx: number };
  author: { emPerChar: number; maxPx: number; minPx: number };
  // The most of the band the author may take, as a fraction.
  authorShare: number;
};

export type SidewaysFit = { titleLines: string[]; titlePx: number; authorPx: number; titleFits: boolean };

// Splits a title into two lines at the space nearest its middle.
function splitInTwo(title: string): string[] {
  const words = title.trim().split(/\s+/);
  if (words.length < 2) return [title.trim()];
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const diff = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
    if (diff < bestDiff) [best, bestDiff] = [i, diff];
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

// Title and author along a thin spine, read bottom to top. The author
// takes what it needs up to its share of the band, the title the rest,
// on one line. A title too long for one line even at the smallest size
// is set on two lines side by side, split between words, as on a real
// thin book. titleFits is false when even that is too long, and the CSS
// ellipsis will cut it.
export function fitSideways(title: string, author: string | null, options: SidewaysOptions): SidewaysFit {
  const { lengthPx, gapPx, authorShare } = options;
  const authorChars = author ? [...author.trim()].length : 0;
  const authorPx = authorChars
    ? clampPx(
        (lengthPx * authorShare) / (authorChars * options.author.emPerChar),
        options.author.minPx,
        options.author.maxPx,
      )
    : 0;
  const authorLengthPx = authorChars ? authorChars * options.author.emPerChar * authorPx + gapPx : 0;
  const room = lengthPx - authorLengthPx;
  const sizeFor = (line: string) => room / (Math.max(1, [...line].length) * options.title.emPerChar);

  const oneLine = title.trim();
  let titleLines = [oneLine];
  let ideal = sizeFor(oneLine);
  if (ideal < options.title.minPx) {
    const twoLines = splitInTwo(oneLine);
    if (twoLines.length === 2) {
      titleLines = twoLines;
      ideal = Math.min(...twoLines.map(sizeFor));
    }
  }
  return {
    titleLines,
    titlePx: clampPx(ideal, options.title.minPx, options.title.maxPx),
    authorPx,
    titleFits: ideal >= options.title.minPx,
  };
}
