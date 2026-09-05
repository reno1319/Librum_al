// LIBRUM 2.0 BLOG-1C: no word-count/reading-time helper or package
// existed anywhere in this repo before BLOG-1 (confirmed by the
// BLOG-1A audit) -- derived at render time from content_markdown,
// never stored (per the BLOG-1 design report's own explicit
// constraint). A raw whitespace split slightly overcounts Markdown
// syntax characters (#, **, -) as separate "words," but this produces
// a "roughly N min read" UX label, not a billing/legal figure --
// precision beyond this is not worth a Markdown-aware token counter.
const WORDS_PER_MINUTE = 200;

export function calculateReadingTime(markdown: string): number {
  const wordCount = markdown.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(wordCount / WORDS_PER_MINUTE));
}
