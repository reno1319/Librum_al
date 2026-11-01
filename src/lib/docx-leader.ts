// Contents-list lines: "Kapitulli 1 .......... 12", "Hyrje\t5", "Fundi   ix".
//
// Linear-time replacement for two backtracking regexes that took seconds to
// minutes on a paragraph that is one long run of dots or spaces:
//
//   LINE = ^\S.{0,150}?(?:[ \t]*(?:\.{2,}|…+|·{2,}|_{2,})[ \t.…·_]*|\t+[ \t]*|[ NBSP]{3,})(?:\d{1,4}|[ivxlcdm]{1,6})$   (flag i)
//   TAIL =             (?:[ \t]*(?:\.{2,}|…+|·{2,}|_{2,})[ \t.…·_]*|\t+[ \t]*| {3,})(?:\d{1,4}|[ivxlcdm]{1,6})$   (flag i)
//
// The two differed in one place: LINE's run of 3+ spaces also counted
// non-breaking spaces (NBSP, U+00A0), TAIL's did not. Both are kept as they
// were. isLeaderLine(s) answers exactly what LINE.test(s) answered, and
// stripLeaderTail(s) returns exactly what s.replace(TAIL, "") returned.
// docx-leader.test.ts checks both against the old regexes on random input.

const NBSP = "\u00a0";
const isSpaceOrTab = (c: string) => c === " " || c === "\t";
const isLeaderChar = (c: string) => c === " " || c === "\t" || c === "." || c === "…" || c === "·" || c === "_";
const isDigit = (c: string) => c >= "0" && c <= "9";
const isRoman = (c: string) => "ivxlcdmIVXLCDM".includes(c);
const isLineTerminator = (c: string) => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";

// A dot leader starts with "..", "…", "··" or "__".
function startsDotLeader(s: string, q: number, end: number): boolean {
  const c = s[q];
  if (c === "…") return true;
  return (c === "." || c === "·" || c === "_") && q + 1 < end && s[q + 1] === c;
}

// Leftmost index p >= minStart where s.slice(p) is "leader + page number",
// or -1 if there is none. nbspInSpaceRun: whether the 3+ spaces leader may
// contain NBSP (LINE: yes, TAIL: no).
function leaderTailStart(s: string, minStart: number, nbspInSpaceRun: boolean): number {
  const n = s.length;
  if (n === 0) return -1;
  // The page number is the whole trailing run of digits (1-4) or of Roman
  // letters (1-6): a leader never ends in a digit or a letter.
  let end = n;
  if (isDigit(s[n - 1])) {
    while (end > 0 && isDigit(s[end - 1])) end--;
    if (n - end > 4) return -1;
  } else if (isRoman(s[n - 1])) {
    while (end > 0 && isRoman(s[end - 1])) end--;
    if (n - end > 6) return -1;
  } else {
    return -1;
  }
  // Each leader is one run of characters that ends at the page number:
  // [ \t.…·_] for the dot and tab leaders, spaces (and maybe NBSP) for the
  // 3+ spaces leader.
  const isPad = (c: string) => c === " " || (nbspInSpaceRun && c === NBSP);
  let leaderStart = end;
  while (leaderStart > 0 && isLeaderChar(s[leaderStart - 1])) leaderStart--;
  let blankStart = end; // run of spaces and tabs only
  while (blankStart > 0 && isSpaceOrTab(s[blankStart - 1])) blankStart--;
  let padStart = end; // run of spaces (and maybe NBSP) only
  while (padStart > 0 && isPad(s[padStart - 1])) padStart--;

  for (let p = Math.max(minStart, Math.min(leaderStart, padStart)), q = p; p < end; p++) {
    if (end - p >= 3 && p >= padStart) return p; // 3+ spaces (LINE: or NBSP)
    if (p < leaderStart) continue; // the other two leaders use only [ \t.…·_]
    if (p >= blankStart && s[p] === "\t") return p; // "\t+[ \t]*"
    // "[ \t]*" + dot leader + "[ \t.…·_]*": q = first non-blank from p.
    if (q < p) q = p;
    while (q < end && isSpaceOrTab(s[q])) q++;
    if (q < end && startsDotLeader(s, q, end)) return p;
  }
  return -1;
}

export function isLeaderLine(s: string): boolean {
  if (s.length === 0 || !/\S/.test(s[0])) return false;
  const p = leaderTailStart(s, 1, true);
  if (p < 0 || p > 151) return false;
  for (let i = 1; i < p; i++) if (isLineTerminator(s[i])) return false;
  return true;
}

export function stripLeaderTail(s: string): string {
  const p = leaderTailStart(s, 0, false);
  return p < 0 ? s : s.slice(0, p);
}
