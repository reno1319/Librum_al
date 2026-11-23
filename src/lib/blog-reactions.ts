// BR1 (Renato, 2026-11-23): reader reactions on blog articles.
// br1 q1: three reactions, in this order. br1 q2: signed-in readers only.
// br1 q3: a reader may pick several; each one turns on and off.
// br1 q4: public counts, a reaction nobody picked shows no number.

export const BLOG_REACTIONS = [
  { key: "like", emoji: "👍", label: "Më pëlqen" },
  { key: "helpful", emoji: "💡", label: "E dobishme" },
  { key: "inspired", emoji: "✨", label: "Më frymëzoi" },
] as const;

export type BlogReaction = (typeof BLOG_REACTIONS)[number]["key"];
export type BlogReactionCounts = Record<BlogReaction, number>;

export function isBlogReaction(value: unknown): value is BlogReaction {
  return BLOG_REACTIONS.some((r) => r.key === value);
}

export function emptyBlogReactionCounts(): BlogReactionCounts {
  return { like: 0, helpful: 0, inspired: 0 };
}

// blog_post_reaction_counts() refuses more ids than this in one call.
export const BLOG_REACTION_COUNTS_MAX_IDS = 500;

export type BlogReactionCountRow = { post_id: string; reaction: string; total: number | string };

// Groups the rows of blog_post_reaction_counts() by article. Unknown
// reactions and broken totals are dropped, never shown.
export function groupBlogReactionCounts(rows: readonly BlogReactionCountRow[] | null | undefined) {
  const byPost = new Map<string, BlogReactionCounts>();
  for (const row of rows ?? []) {
    if (!isBlogReaction(row.reaction)) continue;
    const total = Number(row.total);
    if (!Number.isSafeInteger(total) || total < 0) continue;
    const counts = byPost.get(row.post_id) ?? emptyBlogReactionCounts();
    counts[row.reaction] = total;
    byPost.set(row.post_id, counts);
  }
  return byPost;
}

// The public number beside a button: nothing at zero (br1 q4).
export function publicReactionCount(total: number): string | null {
  return total > 0 ? String(total) : null;
}
