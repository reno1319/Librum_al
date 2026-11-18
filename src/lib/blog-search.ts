// Blog search (bs5/bs6, Renato 2026-11-17): the 🔍 "Kërko" box on /blog
// and every category page sends ?q= to /blog/kerko. The database
// function search_blog_posts() (migration
// 20261117230000_blog_editorial_keywords.sql) matches published posts
// on title, excerpt and the hidden keywords only (never the body),
// ignoring accents and capitals (unaccent + ILIKE: "vetebotim" finds
// "vetë-botim", "cmim" finds "çmim"). Every word must match.
//
// This file only cleans the reader's text before it is sent: it is a
// tidy-up, not the security boundary (the function is SECURITY INVOKER
// and reads published posts only, under the reader's own RLS).
export const BLOG_SEARCH_MAX_LENGTH = 100;
export const BLOG_SEARCH_MAX_WORDS = 5;
export const BLOG_SEARCH_RESULT_LIMIT = 30;

// The text shown back in the box and the "për «…»" line, and the
// cleaned words sent to the database. Missing, repeated (?q=a&q=b) or
// blank → no search. LIKE wildcards (% _ \) and PostgREST's * are
// dropped so a reader's text can never widen the match; words are
// split on spaces, de-duplicated and capped at 5.
export function parseBlogSearchQuery(raw: string | string[] | undefined): {
  display: string;
  term: string | null;
} {
  if (typeof raw !== "string") return { display: "", term: null };
  const display = raw.replace(/\s+/g, " ").trim().slice(0, BLOG_SEARCH_MAX_LENGTH);
  const seen = new Set<string>();
  const words: string[] = [];
  for (const w of display.replace(/[%_\\*]/g, " ").split(" ")) {
    const key = w.toLowerCase();
    if (!w || seen.has(key)) continue;
    seen.add(key);
    words.push(w);
    if (words.length === BLOG_SEARCH_MAX_WORDS) break;
  }
  return { display, term: words.length > 0 ? words.join(" ") : null };
}
