import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GENRES } from "./genres";

// ALBANIAN-3: the genre list is stored data, so it is pinned exactly.
describe("GENRES", () => {
  it("is the eighteen Albanian genres Renato approved, in Albanian alphabetical order", () => {
    expect(GENRES).toEqual([
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
    ]);
    expect([...GENRES].sort(new Intl.Collator("sq").compare)).toEqual([...GENRES]);
  });

  it("holds only NFC strings with no stray spaces and no duplicates", () => {
    for (const genre of GENRES) {
      expect(genre).toBe(genre.normalize("NFC"));
      expect(genre).toBe(genre.trim());
    }
    expect(new Set(GENRES).size).toBe(GENRES.length);
  });

  it("matches the books_genre_check list in supabase/schema.sql exactly", () => {
    const schema = readFileSync(join(process.cwd(), "supabase/schema.sql"), "utf8");
    const match = schema.match(/genre text constraint books_genre_check check \(genre in \(([\s\S]*?)\)\)/);
    expect(match).not.toBeNull();
    const values = [...match![1].matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1].replace(/''/g, "'"));
    expect(values).toEqual([...GENRES]);
  });
});
