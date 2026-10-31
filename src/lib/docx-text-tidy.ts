// W3: typography clean-up for one paragraph's text (Renato's answers
// 3b a and 6a, 31 Oct):
// - straight double quotes follow the author's own habit: „…“ if the
//   book already uses „, «…» if it uses «, otherwise curly “…”;
// - a straight apostrophe in or at the edge of a word (s'e, t', 'i)
//   becomes ’ -- never an opening quote, unless it clearly opens a
//   'quoted phrase' that closes later in the same paragraph; that
//   phrase's closing quote may follow its own punctuation ('Po,' tha);
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
const DIGIT_RE = /^[0-9]$/;
const OPENING_CONTEXT = new Set(["(", "[", "{", "—", "–", "-", "/", "„", "“", "«", "‘", "‚"]);
// Punctuation that can end a quoted phrase just before its closing
// quote: 'Po,' / 'Po.' / 'Po?!' / 'Po...'.
const PHRASE_END_PUNCT = new Set([",", ".", "!", "?", ";", ":", "…"]);

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
  let phraseOpen = false;
  for (let i = 0; i < n; i++) {
    if (chars[i] !== "'") continue;
    const prev = chars[i - 1];
    const next = chars[i + 1];
    if (isLetter(prev)) {
      out[i] = "’";
      counts.apostrophes++;
      // A word's closing quote ends the phrase; a single-letter elision
      // (s', t') inside it does not.
      if (!isLetter(next) && isLetter(chars[i - 2])) phraseOpen = false;
      continue;
    }
    if (phraseOpen && closesAfterPunctuation(chars, i)) {
      out[i] = "’";
      counts.apostrophes++;
      phraseOpen = false;
      continue;
    }
    if ((isSpaceOrStart(prev) || OPENING_CONTEXT.has(prev!)) && isLetter(next)) {
      // Audit W3SW r1 N1: inside an open phrase ('Rock 'n' roll,') and
      // before a two-digit year ('90) it is an apostrophe, never an opener.
      const opens = !phraseOpen && !isShortYear(chars, i) && opensQuotedPhrase(chars, i);
      out[i] = opens ? "‘" : "’";
      if (opens) phraseOpen = true;
      counts.apostrophes++;
    }
  }
  return out;
}

// '90, '44: an elided year, exactly two digits.
function isShortYear(chars: string[], i: number): boolean {
  return DIGIT_RE.test(chars[i + 1] ?? "") && DIGIT_RE.test(chars[i + 2] ?? "") && !isLetter(chars[i + 3]);
}

// A straight quote right after a word's closing punctuation ("Po,'",
// "Po?!'", "Po...'") and before a non-letter.
function closesAfterPunctuation(chars: string[], j: number): boolean {
  if (isLetter(chars[j + 1])) return false;
  let k = j - 1;
  while (k >= 0 && PHRASE_END_PUNCT.has(chars[k])) k--;
  return k < j - 1 && isLetter(chars[k]);
}

// 'like this' -- a later straight quote closes a word of 2+ letters and
// is followed by a non-letter, or follows that phrase's own closing
// punctuation ('Po,' tha). Single-letter elisions (s', t', m') never
// close a phrase.
function opensQuotedPhrase(chars: string[], start: number): boolean {
  for (let j = start + 1; j < chars.length; j++) {
    if (chars[j] !== "'") continue;
    if (closesAfterPunctuation(chars, j)) return true;
    if (!isLetter(chars[j - 1]) || isLetter(chars[j + 1])) continue;
    if (!isLetter(chars[j - 2])) continue; // single-letter elision
    return j - start > 2;
  }
  return false;
}
