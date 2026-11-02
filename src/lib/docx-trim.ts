// Trimming paragraph text: whitespace, NBSP, zero-width space and BOM.
//
// Linear-time replacement for two backtracking regexes in
// docx-paragraphs.ts that were quadratic on "x" + a long run of spaces +
// "y" (100,000 spaces took about 26 s per paragraph):
//
//   text.replace(/^[\s\u00a0\u200b\ufeff]+|[\s\u00a0\u200b\ufeff]+$/g, "")   -> trimSpace(text)
//   text.replace(/[\s\u00a0\u200b\ufeff]+$/, "")                              -> trimSpaceEnd(text)
//
// Same characters, same output; docx-trim.test.ts checks both against the
// old regexes on random input.

// One character at a time, so this test is never slow.
const SPACE_CHAR_RE = /^[\s\u00a0\u200b\ufeff]$/;
const isSpaceChar = (c: string) => SPACE_CHAR_RE.test(c);

export function trimSpaceEnd(t: string): string {
  let end = t.length;
  while (end > 0 && isSpaceChar(t[end - 1])) end--;
  return end === t.length ? t : t.slice(0, end);
}

export function trimSpace(t: string): string {
  let start = 0;
  while (start < t.length && isSpaceChar(t[start])) start++;
  let end = t.length;
  while (end > start && isSpaceChar(t[end - 1])) end--;
  return start === 0 && end === t.length ? t : t.slice(start, end);
}
