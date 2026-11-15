// K8 + K10 (Renato 11-15): where a place, a bookmark or a highlight is
// in a book. Everything is a character offset into the book's text, the
// way the reader's frame lays it out (the textContent of #lb-root, the
// buyer line included). Offsets do not depend on font, size or screen,
// so a place saved on a phone opens at the same words on a computer.
//
// A highlight also keeps its exact words and a little text on each side
// (prefix/suffix), so when the author uploads a changed version it can
// be found again even if the words moved (Q3 a: words that are gone are
// kept as "changed", never deleted). Pure functions; the reader does the
// DOM work.

export const HIGHLIGHT_COLORS = ["yellow", "green", "blue", "pink"] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export const HIGHLIGHT_COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: "E verdhë",
  green: "E gjelbër",
  blue: "Blu",
  pink: "Rozë",
};

// The limits (also in the database: 23514 'reader_marks_limit' and the
// column checks).
export const MAX_HIGHLIGHTS_PER_BOOK = 3000;
export const MAX_BOOKMARKS_PER_BOOK = 500;
export const MAX_NOTE_LENGTH = 1000;
export const MAX_QUOTE_LENGTH = 4000;
export const CONTEXT_LENGTH = 32;

export function isHighlightColor(value: unknown): value is HighlightColor {
  return typeof value === "string" && (HIGHLIGHT_COLORS as readonly string[]).includes(value);
}

export type TextAnchor = { start: number; end: number; quote: string; prefix: string; suffix: string };

/** The words of [start, end) with up to CONTEXT_LENGTH characters on each side. */
export function anchorFor(text: string, start: number, end: number): TextAnchor | null {
  const s = Math.max(0, Math.min(start, text.length));
  const e = Math.max(0, Math.min(end, text.length));
  if (e <= s || e - s > MAX_QUOTE_LENGTH) return null;
  const quote = text.slice(s, e);
  if (quote.trim() === "") return null;
  return {
    start: s,
    end: e,
    quote,
    prefix: text.slice(Math.max(0, s - CONTEXT_LENGTH), s),
    suffix: text.slice(e, e + CONTEXT_LENGTH),
  };
}

// Letters, digits and the joiners inside a word (don't, -, ’).
const WORD_CHAR = /[\p{L}\p{N}\p{M}'’\-]/u;

/**
 * A press-and-drag selection, grown to whole words and trimmed of the
 * spaces at its ends. Start and end may come in either order.
 */
export function snapToWords(text: string, a: number, b: number): { start: number; end: number } | null {
  let start = Math.max(0, Math.min(a, b, text.length));
  let end = Math.min(text.length, Math.max(a, b));
  if (end === start && end < text.length) end = start + 1;
  while (start > 0 && WORD_CHAR.test(text[start - 1]) && WORD_CHAR.test(text[start])) start--;
  while (end < text.length && end > 0 && WORD_CHAR.test(text[end - 1]) && WORD_CHAR.test(text[end])) end++;
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? { start, end } : null;
}

function commonSuffixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

function commonPrefixLength(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

const MAX_CANDIDATES = 2000;

/**
 * Finds a saved highlight in the book's current text. Its own place
 * first; else every place with the same words, the best one by the text
 * around it (then by closeness to the old place). Null = the words are
 * not in this version any more.
 */
export function reanchor(text: string, anchor: TextAnchor): { start: number; end: number } | null {
  const { start, end, quote, prefix, suffix } = anchor;
  if (!quote) return null;
  if (start >= 0 && end <= text.length && text.slice(start, end) === quote) return { start, end };
  let best: { start: number; score: number; distance: number } | null = null;
  let from = 0;
  for (let i = 0; i < MAX_CANDIDATES; i++) {
    const at = text.indexOf(quote, from);
    if (at === -1) break;
    const before = text.slice(Math.max(0, at - prefix.length), at);
    const after = text.slice(at + quote.length, at + quote.length + suffix.length);
    const score = commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix);
    const distance = Math.abs(at - start);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { start: at, score, distance };
    from = at + 1;
  }
  return best ? { start: best.start, end: best.start + quote.length } : null;
}

/** Index of the last item with key <= value in a sorted list (or -1). */
export function lastAtOrBefore(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= value) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * The first offset in [lo, hi] for which `isAtOrAfter` is true, given it
 * is false then true along the book (pages run in text order). hi + 1
 * when it never is.
 */
export function firstOffsetWhere(lo: number, hi: number, isAtOrAfter: (offset: number) => boolean): number {
  let a = lo;
  let b = hi + 1;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (isAtOrAfter(mid)) b = mid;
    else a = mid + 1;
  }
  return a;
}

/** The share of the book read, 0..1, from the place's offset. The last page counts as all of it. */
export function progressOf(offset: number, textLength: number, onLastPage: boolean): number {
  if (onLastPage) return 1;
  if (textLength <= 0) return 0;
  return Math.round(Math.min(1, Math.max(0, offset / textLength)) * 10000) / 10000;
}

/** The Biblioteka ime line under the bar. */
export function progressLabel(progress: number): string {
  if (progress >= 0.995) return "Përfunduar";
  return `${Math.max(1, Math.floor(progress * 100))}% e lexuar`;
}

// ------------------------------------------------------------------
// The reading place in this browser (3a, now with sync). Kept per book:
// the offset, the share read, and the server time of this browser's
// last saved place ("synced"). Another device's place wins only when the
// server's place is newer than that (Q6 a): no device clocks compared.
// ------------------------------------------------------------------
export type LocalPlace = { offset: number | null; progress: number; synced: string | null };

/** A stored place: the new {o,p,s} form, or the older bare share (0..1). */
export function parseLocalPlace(raw: string | null): LocalPlace | null {
  if (raw === null || raw.trim() === "") return null;
  const bare = Number(raw);
  if (Number.isFinite(bare)) return bare >= 0 && bare <= 1 ? { offset: null, progress: bare, synced: null } : null;
  try {
    const v = JSON.parse(raw) as { o?: unknown; p?: unknown; s?: unknown };
    const offset = typeof v.o === "number" && Number.isInteger(v.o) && v.o >= 0 ? v.o : null;
    const progress = typeof v.p === "number" && v.p >= 0 && v.p <= 1 ? v.p : null;
    const synced = typeof v.s === "string" && !Number.isNaN(Date.parse(v.s)) ? v.s : null;
    if (offset === null || progress === null) return null;
    return { offset, progress, synced };
  } catch {
    return null;
  }
}

export function serializeLocalPlace(place: { offset: number; progress: number; synced: string | null }): string {
  return JSON.stringify({ o: place.offset, p: place.progress, s: place.synced });
}

export type ServerPlace = { offset: number; progress: number; updatedAt: string };

/**
 * Q6 a: the server's place wins when it was saved after this browser's
 * last save (or this browser has none); else this browser's place.
 */
export function serverPlaceWins(server: ServerPlace | null, local: LocalPlace | null): boolean {
  if (!server) return false;
  if (!local || local.offset === null || !local.synced) return true;
  return Date.parse(server.updatedAt) > Date.parse(local.synced);
}
