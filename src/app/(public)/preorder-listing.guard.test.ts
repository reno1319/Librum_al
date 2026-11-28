import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// BD16 P4 (D1): where pre-orders are listed and where they are not.
// A source guard (these pages have no rendered-test harness of their
// own): the listing queries use LISTED_BOOK_STATUSES, and the home page
// and the "free to start reading" shelf stay published-only.

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const count = (text: string, needle: string) => text.split(needle).length - 1;
const IN_LISTED = '.in("status", LISTED_BOOK_STATUSES)';

describe("pre-orders in public lists", () => {
  // LR1: the results (plain and searched), every shelf and the category
  // buttons' read. The free shelf is gone (lr1-7 a).
  it("Libraria lists them in the results, in search, on the shelves and in the category read", () => {
    const src = read("src/app/(public)/librari/page.tsx");
    expect(count(src, IN_LISTED)).toBe(4);
    expect(src).not.toContain("fetchFreeBooks");
  });

  it("the author page, the series page and the sitemap list them", () => {
    for (const path of ["src/app/(public)/autore/[id]/page.tsx", "src/app/(public)/seri/[id]/page.tsx", "src/app/sitemap.ts"]) {
      expect(count(read(path), IN_LISTED), path).toBe(1);
    }
  });

  // P1: plus the author's book count, which counts what "More by" lists.
  // Amazon page (md1 a): two shelves now (series, you-might-like).
  // Amazon page P2: plus the shelf's "Nga <autori>" and category chips.
  // Amazon page P5: plus the "bought together" books read.
  it("the book page's shelves and the author's book count list them", () => {
    expect(count(read("src/app/(public)/libra/[id]/page.tsx"), IN_LISTED)).toBe(6);
  });

  it("the home page stays released books only", () => {
    const src = read("src/app/(public)/page.tsx");
    expect(src).not.toContain("LISTED_BOOK_STATUSES");
    expect(src).not.toContain("preorder");
  });
});
