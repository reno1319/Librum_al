// W3: typography clean-up for one paragraph's text (Renato's answers
// 3b a and 6a, 31 Oct):
// - straight double quotes follow the author's own habit: „…“ if the
//   book already uses „, «…» if it uses «, otherwise curly “…”;
// - a straight apostrophe in or at the edge of a word (s'e, t', 'i)
//   becomes ’ -- never an opening quote, unless it clearly opens a
//   'quoted phrase' that closes later in the same paragraph;
// - "..." becomes "…", a spaced "--" becomes "—";
// - a hyphen that opens dialogue ("- Po, tha.") becomes the dash the
//   author uses most for dialogue ("—" if none).
// The functions work on a plain string and return, for every input
// character, what it becomes (a string, possibly empty), so the caller
// can write the result back into Word's separate text runs.

export type QuoteStyle = "curly" | "low9" | "guillemets";
export type DialogueDash = "—" | "–";

export type TidyCounts = { quotes: number; apostrophes: number; ellipses: number; dashes: number };

export function emptyTidyCounts(): TidyCounts {
  return { quotes: 0, apostrophes: 0, ellipses: 0, dashes: 0 };
}

export function detectQuoteStyle(fullText: string): QuoteStyle {
  let low9 = 0;
  let guillemets = 0;
  for (const ch of fullText) {
    if (ch === "„") low9++;
    else if (ch === "«") guillemets++;
  }
  if (low9 === 0 && guillemets === 0) return "curly";
  return low9 >= guillemets ? "low9" : "guillemets";
}

const DIALOGUE_START_RE = /^([—–-])[  ]/;

export function detectDialogueDash(paragraphTexts: string[]): DialogueDash {
  let em = 0;
  let en = 0;
  for (const t of paragraphTexts) {
    const m = t.match(DIALOGUE_START_RE);
    if (!m) continue;
    if (m[1] === "—") em++;
    else if (m[1] === "–") en++;
  }
  return en > em ? "–" : "—";
}

const QUOTE_PAIRS: Record<QuoteStyle, [string, string]> = {
  curly: ["“", "”"],
  low9: ["„", "“"],
  guillemets: ["«", "»"],
};

const LETTER_RE = /[\p{L}\p{N}]/u;
const SPACE_RE = /[\s ]/;
const OPENING_CONTEXT = new Set(["(", "[", "{", "—", "–", "-", "/", "„", "“", "«", "‘", "‚"]);

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && LETTER_RE.test(ch);
}
function isSpaceOrStart(ch: string | undefined): boolean {
  return ch === undefined || SPACE_RE.test(ch);
}

export function tidyText(
  text: string,
  options: { quoteStyle: QuoteStyle; dialogueDash: DialogueDash },
  counts: TidyCounts,
): string[] {
  const chars = Array.from(text);
  const out = chars.slice();
  const n = chars.length;

  // Dialogue: a paragraph opening with "- " uses the author's dash, and
  // so do its spaced " - " interruptions ("— Po, - tha ai.").
  if (n >= 2 && chars[0] === "-" && SPACE_RE.test(chars[1])) {
    out[0] = options.dialogueDash;
    counts.dashes++;
    for (let i = 1; i + 1 < n; i++) {
      if (chars[i] === "-" && SPACE_RE.test(chars[i - 1]) && SPACE_RE.test(chars[i + 1])) {
        out[i] = options.dialogueDash;
        counts.dashes++;
      }
    }
  }

  for (let i = 0; i < n; i++) {
    // Spaced double hyphen.
    if (chars[i] === "-" && chars[i + 1] === "-" && chars[i + 2] !== "-" && chars[i - 1] !== "-") {
      if (isSpaceOrStart(chars[i - 1]) && (i + 2 >= n || SPACE_RE.test(chars[i + 2]))) {
        out[i] = "—";
        out[i + 1] = "";
        counts.dashes++;
        i++;
        continue;
      }
    }
    // Exactly three dots.
    if (chars[i] === "." && chars[i + 1] === "." && chars[i + 2] === "." && chars[i + 3] !== "." && chars[i - 1] !== ".") {
      out[i] = "…";
      out[i + 1] = "";
      out[i + 2] = "";
      counts.ellipses++;
      i += 2;
      continue;
    }
  }

  // Straight double quotes.
  const [open, close] = QUOTE_PAIRS[options.quoteStyle];
  let inside = false;
  for (let i = 0; i < n; i++) {
    if (chars[i] !== '"') continue;
    const prev = chars[i - 1];
    const next = chars[i + 1];
    let opening: boolean;
    if (isSpaceOrStart(prev) || OPENING_CONTEXT.has(prev!)) opening = !(next === undefined || SPACE_RE.test(next));
    else opening = false;
    // A quote between two spaces: follow the open/close alternation.
    if (isSpaceOrStart(prev) && (next === undefined || SPACE_RE.test(next))) opening = !inside;
    out[i] = opening ? open : close;
    inside = opening;
    counts.quotes++;
  }

  // Straight apostrophes / single quotes.
  for (let i = 0; i < n; i++) {
    if (chars[i] !== "'") continue;
    const prev = chars[i - 1];
    const next = chars[i + 1];
    if (isLetter(prev)) {
      out[i] = "’";
      counts.apostrophes++;
      continue;
    }
    if ((isSpaceOrStart(prev) || OPENING_CONTEXT.has(prev!)) && isLetter(next)) {
      out[i] = opensQuotedPhrase(chars, i) ? "‘" : "’";
      counts.apostrophes++;
    }
  }
  return out;
}

// 'like this' -- a later straight quote closes a word of 2+ letters and
// is followed by a non-letter. Single-letter elisions (s', t', m') never
// close a phrase.
function opensQuotedPhrase(chars: string[], start: number): boolean {
  for (let j = start + 1; j < chars.length; j++) {
    if (chars[j] !== "'") continue;
    if (!isLetter(chars[j - 1]) || isLetter(chars[j + 1])) continue;
    if (!isLetter(chars[j - 2])) continue; // single-letter elision
    return j - start > 2;
  }
  return false;
}
