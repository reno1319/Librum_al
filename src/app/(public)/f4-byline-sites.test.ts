import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// F4 (P5, Q4 = a): every place a BOOK's author name shows uses
// resolveBookByline (its pen name, else the author's public name), and
// the places that name the AUTHOR keep resolvePublicAuthorName.

function readSrc(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), "src", relativePath), "utf8");
}

const BYLINE_SITES: [file: string, expected: string[]][] = [
  ["components/book-shelf.tsx", ["authorName={resolveBookByline(book, book.profiles)}"]],
  [
    "app/(public)/bookstore/page.tsx",
    [
      // FeaturedBook (its "by" line and no-cover placeholder) and both card shelves.
      "const authorName = resolveBookByline(book, book.profiles);",
      "authorName={resolveBookByline(book, book.profiles)}",
    ],
  ],
  ["app/(public)/library/page.tsx", ["authorName={resolveBookByline(book, book.profiles)}"]],
  ["app/(public)/wishlist/page.tsx", ["authorName={resolveBookByline(book, book.profiles)}"]],
  ["app/(public)/authors/[id]/page.tsx", ["authorName={resolveBookByline(book, author) ?? authorPublicName}"]],
  [
    "app/(public)/page.tsx",
    ["const books = await attachPenNames(supabase, data ?? []);", "author: resolveBookByline(b, b.profiles),"],
  ],
  [
    "app/(public)/books/[id]/page.tsx",
    ["const bookByline = resolveBookByline(book, book.profiles);", "authorName={bookByline}", "{bookByline}"],
  ],
  [
    "app/api/books/[id]/sample/route.ts",
    ["const [bylineBook] = await attachPenNames(supabase, [{ id: book.id }]);", "author: resolveBookByline(bylineBook, book.profiles),"],
  ],
  ["app/(public)/dashboard/books/new/upload-wizard.tsx", ["authorName={byline}"]],
];

describe("F4: book bylines", () => {
  it.each(BYLINE_SITES)("%s uses the book byline", (file, expected) => {
    const source = readSrc(file);
    for (const snippet of expected) expect(source).toContain(snippet);
  });

  it("the bookstore resolves every book name through the byline (three sites), the bundle line through the author", () => {
    const source = readSrc("app/(public)/bookstore/page.tsx");
    expect(source.match(/resolveBookByline\(book, book\.profiles\)/g)).toHaveLength(3);
    expect(source).toContain("const authorName = resolvePublicAuthorName(bundle.profiles);");
    expect(source).not.toContain("resolvePublicAuthorName(book.profiles)");
  });

  it("explicit select lists never name pen_name (they would fail before the migration)", () => {
    for (const file of ["app/(public)/page.tsx", "app/api/books/[id]/sample/route.ts"]) {
      const selects = readSrc(file).match(/\.select\("[^"]*"\)/g) ?? [];
      for (const select of selects) {
        if (select === '.select("id, pen_name")') continue;
        expect(select).not.toContain("pen_name");
      }
    }
  });
});

describe("F4: places that name the author keep the author's name", () => {
  it("book page: About the author and More by ... use authorName (resolvePublicAuthorName)", () => {
    const source = readSrc("app/(public)/books/[id]/page.tsx");
    expect(source).toContain("const authorName = resolvePublicAuthorName(book.profiles);");
    expect(source).toContain('<p className="font-serif text-[1.375rem] text-primary">{authorName}</p>');
    expect(source).toContain("title={authorName ? `More by ${authorName}` : \"More by this author\"}");
    // The by-line still links to the author's page.
    expect(source).toMatch(/href=\{`\/authors\/\$\{book\.author_id\}`\} className=\{INLINE_LINK_CLASSES\}>\s*\{bookByline\}/);
  });

  it.each([
    "lib/email.ts",
    "app/(public)/following/page.tsx",
    "app/(public)/authors/[id]/page.tsx",
    "app/admin/(protected)/reports/[id]/page.tsx",
  ])("%s does not use the book byline for the author's own name", (file) => {
    const source = readSrc(file);
    expect(source).toContain("resolvePublicAuthorName(");
  });

  it("the follower email keeps the author's name (Q7 = a)", () => {
    const source = readSrc("lib/email.ts");
    expect(source).not.toContain("resolveBookByline");
    expect(source).not.toContain("pen_name");
  });

  it("dashboard lists are unchanged", () => {
    expect(readSrc("components/author-book-row.tsx")).not.toContain("resolveBookByline");
  });
});
