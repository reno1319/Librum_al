import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// F4 (P5, Q4 = a), as superseded by PEN-NAMES-1 (owner decisions 1a-4a,
// 2026-10-19): every place a BOOK's author name shows uses
// resolveBookByline -- the book's pen name, embedded from the
// public_pen_names view as `pen` -- and links to that pen name's page.
// The places that named the AUTHOR (book page "Rreth autorit" and
// "More by", the author page, Following, the follower email) now name
// the pen name too (3a, 4a).

function readSrc(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), "src", relativePath), "utf8");
}

const BYLINE_SITES: [file: string, expected: string[]][] = [
  ["components/book-shelf.tsx", ["authorName={resolveBookByline(book)}"]],
  [
    "app/(public)/bookstore/page.tsx",
    [
      // FeaturedBook (its "by" line and no-cover placeholder) and both card shelves.
      "const authorName = resolveBookByline(book);",
      "authorName={resolveBookByline(book)}",
    ],
  ],
  ["app/(public)/library/page.tsx", ["authorName={resolveBookByline(book)}", "penNameId={book.pen?.id ?? null}"]],
  ["app/(public)/wishlist/page.tsx", ["authorName={resolveBookByline(book)}"]],
  // HOME-PICKS-1: the newest list and the fan's picks share toCover.
  ["app/(public)/page.tsx", ["author: resolveBookByline(b),"]],
  [
    "app/(public)/books/[id]/page.tsx",
    ["const bookByline = resolveBookByline(book);", "authorName={bookByline}", "{bookByline}"],
  ],
  ["app/api/books/[id]/sample/route.ts", ["author: resolveBookByline(book),"]],
  ["app/admin/(protected)/librum-choice/page.tsx", ["resolveBookByline(pick)", "resolveBookByline(book)"]],
  ["app/(public)/dashboard/books/new/upload-wizard.tsx", ["authorName={byline}"]],
];

describe("F4 / PEN-NAMES-1: book bylines", () => {
  it.each(BYLINE_SITES)("%s uses the book byline", (file, expected) => {
    const source = readSrc(file);
    for (const snippet of expected) expect(source).toContain(snippet);
  });

  // BOOKSTORE ORNATE SHELF: the fourth site is the ornate shelf's author line.
  it("the bookstore resolves every book name through the byline (four sites), the bundle line through the bundle's pen name", () => {
    const source = readSrc("app/(public)/bookstore/page.tsx");
    expect(source.match(/resolveBookByline\(book\)/g)).toHaveLength(4);
    expect(source).toContain("author: resolveBookByline(book),");
    expect(source).toContain("const authorName = bundle.pen?.name ?? null;");
    expect(source).not.toContain("resolvePublicAuthorName");
  });

  it("every byline query embeds the pen name view, never the account's public name", () => {
    for (const file of [
      "app/(public)/page.tsx",
      "app/api/books/[id]/sample/route.ts",
      "app/(public)/bookstore/page.tsx",
      "app/(public)/library/page.tsx",
      "app/(public)/wishlist/page.tsx",
      "lib/librum-choice.ts",
      "app/admin/(protected)/librum-choice/page.tsx",
    ]) {
      const source = readSrc(file);
      expect(source).toContain("pen:public_pen_names(id, name)");
      expect(source).not.toContain("public_author_profiles(public_author_name)");
    }
  });
});

describe("PEN-NAMES-1: places that named the author now name the pen name", () => {
  it("book page: Rreth autorit and More by ... use the pen name and link to its page (3a)", () => {
    const source = readSrc("app/(public)/books/[id]/page.tsx");
    expect(source).toContain("const authorName = bookByline;");
    expect(source).toContain('<p className="font-serif text-[1.375rem] text-primary">{authorName}</p>');
    expect(source).toContain("title={authorName ? `Më shumë nga ${authorName}` : \"Më shumë nga ky autor\"}");
    expect(source).toContain('.eq("pen_name_id", book.pen_name_id)');
    expect(source).toMatch(/<Link href=\{penNamePath\} className=\{INLINE_LINK_CLASSES\}>\s*\{bookByline\}/);
    expect(source).not.toMatch(/\/authors\/\$\{book\.author_id\}/);
  });

  it("the author page names its pen name and lists only that pen name's books and bundles (1a)", () => {
    const source = readSrc("app/(public)/authors/[id]/page.tsx");
    expect(source).toContain("const authorPublicName = author.name;");
    expect(source.match(/\.eq\("pen_name_id", id\)/g)?.length).toBeGreaterThanOrEqual(4);
    expect(source).not.toMatch(/\.eq\("author_id", id\)/);
    expect(source).not.toContain("No biography added yet.");
  });

  it("Following lists followed pen names", () => {
    const source = readSrc("app/(public)/following/page.tsx");
    expect(source).toContain('.from("pen_name_follows")');
    expect(source).toContain('.from("public_pen_names")');
    expect(source).toContain("{author.name}");
  });

  it("the follower email names the book's pen name (4a)", () => {
    const source = readSrc("lib/email.ts");
    expect(source).not.toContain("resolveBookByline");
    expect(source).toContain("const authorName = penName.name;");
  });

  it("the staff report page still shows the account's names (staff-only)", () => {
    expect(readSrc("app/admin/(protected)/reports/[id]/page.tsx")).toContain("resolvePublicAuthorName(");
  });

  it("dashboard lists are unchanged", () => {
    expect(readSrc("components/author-book-row.tsx")).not.toContain("resolveBookByline");
  });
});
