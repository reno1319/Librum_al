import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// D2 (Renato 11-04): on the site a book cover is "ballinë" (Ballina,
// ballinën, ballinës ...), never "kopertinë". Only the code that spots
// the old word inside an author's own Word or EPUB file may still name
// it, plus the tests of that code and the D1 test that checks the old
// word is gone. Code comments (lines starting with //) may name it when
// they record this change.
const ALLOWED = new Set([
  "src/lib/docx-structure.ts",
  "src/lib/docx-front-matter.test.ts",
  "src/lib/epub-librum-pages.ts",
  "src/lib/epub-librum-pages.test.ts",
  "src/components/book-details-form.rendered.test.ts",
  "src/components/book-content-form.rendered.test.ts",
  "src/lib/ballina-wording.test.ts",
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("D2: ballinë, not kopertinë", () => {
  it("no other source file says kopertinë", () => {
    const root = process.cwd();
    const offenders = files(join(root, "src"))
      .map((path) => relative(root, path).split("\\").join("/"))
      .filter((path) => !ALLOWED.has(path))
      .filter((path) =>
        readFileSync(join(root, path), "utf8")
          .split("\n")
          .some((line) => !/^\s*\/\//.test(line) && /kopertin/i.test(line)),
      );
    expect(offenders).toEqual([]);
  });

  it("the header has no Kryefaqja link and the empty Libraria points home in words", () => {
    const root = process.cwd();
    expect(readFileSync(join(root, "src/components/site-header.tsx"), "utf8")).not.toContain('label: "Kryefaqja"');
    const librari = readFileSync(join(root, "src/app/(public)/librari/page.tsx"), "utf8");
    expect(librari).toContain("Kthehuni në faqen kryesore");
    expect(librari).not.toContain("Kryefaqja");
  });
});
