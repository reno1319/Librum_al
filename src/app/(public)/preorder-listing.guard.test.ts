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
  it("Libraria lists them in the grid and in search, not in the free shelf", () => {
    const src = read("src/app/(public)/librari/page.tsx");
    expect(count(src, IN_LISTED)).toBe(2);
    const free = src.slice(src.indexOf("async function fetchFreeBooks"));
    expect(free.slice(0, free.indexOf("return data"))).toContain('.eq("status", "published")');
  });

  it("the author page, the series page and the sitemap list them", () => {
    for (const path of ["src/app/(public)/autore/[id]/page.tsx", "src/app/(public)/seri/[id]/page.tsx", "src/app/sitemap.ts"]) {
      expect(count(read(path), IN_LISTED), path).toBe(1);
    }
  });

  it("the book page's three shelves list them", () => {
    expect(count(read("src/app/(public)/libra/[id]/page.tsx"), IN_LISTED)).toBe(3);
  });

  it("the home page stays released books only", () => {
    const src = read("src/app/(public)/page.tsx");
    expect(src).not.toContain("LISTED_BOOK_STATUSES");
    expect(src).not.toContain("preorder");
  });
});
