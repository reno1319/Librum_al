// P1 book page (design B, 2026-11-10): the "Kohë leximi" tile. Built from
// the same counted words as the "Faqe" tile (src/lib/page-estimate.ts) at
// 250 words a minute. Renato 11-10 (card a): under one hour it reads in
// minutes ("~4 min"), from one hour up in whole hours ("~3 orë"). No
// count: no tile.

export const WORDS_PER_MINUTE = 250;
export const READING_TIME_LABEL = "Kohë leximi";

export function readingTimeText(words: unknown): string | null {
  if (typeof words !== "number" || !Number.isInteger(words) || words <= 0) return null;
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  if (minutes < 60) return `~${minutes} min`;
  return `~${Math.round(minutes / 60)} orë`;
}
