// ALBANIAN-3 (Renato 10-28, "B a" + "C ok"): genres are stored in
// Albanian -- these exact strings are what books.genre holds, so this
// list and the books_genre_check CHECK in supabase/schema.sql must stay
// identical (migration 20261028150000_albanian_genres.sql). Eighteen:
// the fourteen earlier genres translated, plus Drama & teatër, Filozofi,
// Psikologji and Shkencë. Kept in Albanian alphabetical order (Ç after
// C, Dh after D, Ë after E), which is the order every genre list shows.
// All strings are Unicode NFC (ë is the single code point U+00EB).
export const GENRES = [
  "Biografi & kujtime",
  "Biznes & ekonomi",
  "Drama & teatër",
  "Fantashkencë",
  "Fantazi",
  "Filozofi",
  "Histori",
  "Horror",
  "Letërsi artistike",
  "Për fëmijë",
  "Për të rinj",
  "Poezi",
  "Policor & triler",
  "Psikologji",
  "Publicistikë & ese",
  "Romancë",
  "Shkencë",
  "Zhvillim personal",
] as const;

export type Genre = (typeof GENRES)[number];
