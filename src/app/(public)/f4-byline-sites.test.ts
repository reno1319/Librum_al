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
    "app/(public)/librari/page.tsx",
    [
      // FeaturedBook (its "by" line and no-cover placeholder) and both card shelves.
      "const authorName = resolveBookByline(book);",
      "authorName={resolveBookByline(book)}",
    ],
  ],
  ["app/(public)/library/page.tsx", ["authorName={resolveBookByline(book)}", "penNameId={resolveOriginalAuthor(book) ? null : (book.pen?.id ?? null)}"]],
  ["app/(public)/wishlist/page.tsx", ["authorName={resolveBookByline(book)}"]],
  // HOME-PICKS-1: the newest list and the fan's picks share toCover.
  ["app/(public)/page.tsx", ["author: resolveBookByline(b),"]],
  [
    "app/(public)/libra/[id]/page.tsx",
    ["const bookByline = resolveBookByline(book);", "authorName={bookByline}", "{bookByline}"],
  ],
  ["app/api/books/[id]/sample/route.ts", ["author: resolveBookByline(book),"]],
  // BD3 patch 4 r2 (audit r1, M1/L6): staff see both names.
  ["app/admin/(protected)/librum-choice/page.tsx", ["resolveStaffByline(pick)", "resolveStaffByline(book)"]],
  ["app/(public)/dashboard/books/new/upload-wizard.tsx", ["authorName={byline}"]],
];

describe("F4 / PEN-NAMES-1: book bylines", () => {
  it.each(BYLINE_SITES)("%s uses the book byline (staff: both names)", (file, expected) => {
    const source = readSrc(file);
    for (const snippet of expected) expect(source).toContain(snippet);
  });

  // BOOKSTORE ORNATE SHELF: the fourth site is the ornate shelf's author line.
  it("the bookstore resolves every book name through the byline (four sites), the bundle line through the bundle's pen name", () => {
    const source = readSrc("app/(public)/librari/page.tsx");
    expect(source.match(/resolveBookByline\(book\)/g)).toHaveLength(4);
    expect(source).toContain("author: resolveBookByline(book),");
    expect(source).toContain("const authorName = bundle.pen?.name ?? null;");
    expect(source).not.toContain("resolvePublicAuthorName");
  });

  it("every byline query embeds the pen name view, never the account's public name", () => {
    for (const file of [
      "app/(public)/page.tsx",
      "app/api/books/[id]/sample/route.ts",
      "app/(public)/librari/page.tsx",
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
    const source = readSrc("app/(public)/libra/[id]/page.tsx");
    // BD3 patch 4: the byline can be an original author; these two
    // stay on the pen name.
    expect(source).toContain("const authorName = resolveBookPenName(book);");
    expect(source).toContain('<p className="font-serif text-[1.375rem] text-primary">{authorName}</p>');
    expect(source).toContain("title={authorName ? `Më shumë nga ${authorName}` : \"Më shumë nga ky autor\"}");
    expect(source).toContain('.eq("pen_name_id", book.pen_name_id)');
    expect(source).toMatch(/<Link href=\{penNamePath\} className=\{INLINE_LINK_CLASSES\}>\s*\{bookByline\}/);
    expect(source).not.toMatch(/\/autore\/\$\{book\.author_id\}/);
  });

  it("the author page names its pen name and lists only that pen name's books and bundles (1a)", () => {
    const source = readSrc("app/(public)/autore/[id]/page.tsx");
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
    expect(source).toContain("const authorName = escapeEmailHtml(penName.name);");
    expect(source).toContain("const subject = `${penName.name} publikoi një libër të ri`;");
  });

  it("the staff report page still shows the account's names (staff-only)", () => {
    expect(readSrc("app/admin/(protected)/reports/[id]/page.tsx")).toContain("resolvePublicAuthorName(");
  });

  it("dashboard lists are unchanged", () => {
    expect(readSrc("components/author-book-row.tsx")).not.toContain("resolveBookByline");
  });
});

// BD3 patch 4 (Renato 1 Nov, 1a 2a 4a 5a; 16:05Z 1a 2a 3a).
describe("BD3 patch 4: the original author", () => {
  it("book page: the original author is the byline (plain), 'Përktheu:' under it; About/More by stay on the pen name", () => {
    const source = readSrc("app/(public)/libra/[id]/page.tsx");
    expect(source).toContain("const originalAuthor = resolveOriginalAuthor(book);");
    expect(source).toMatch(/\{originalAuthor \? \(\s*<span className="font-semibold">\{originalAuthor\}<\/span>/);
    expect(source).toContain("{TRANSLATED_BY}");
    expect(source).toContain('(contributors ?? []).filter((c) => c.role === "Translator")');
    expect(source).toContain("otherContributors.length > 0");
    expect(source).toContain("originalAuthor,\n          translators: translatorNames,");
  });

  it("featured book and library cards do not link an original author to the uploader's page", () => {
    expect(readSrc("app/(public)/librari/page.tsx")).toContain("{authorName && book.pen && !resolveOriginalAuthor(book) && (");
    expect(readSrc("components/book-card.tsx")).toContain("book.pen_name_id && !resolveOriginalAuthor(book)");
  });

  it("every explicit book select that feeds a byline reads original_author", () => {
    expect(readSrc("app/(public)/page.tsx")).toContain("description, original_author, pen:public_pen_names(id, name)");
    expect(readSrc("app/api/books/[id]/sample/route.ts")).toContain("status, original_author, pen:public_pen_names");
    const choice = readSrc("app/admin/(protected)/librum-choice/page.tsx");
    expect(choice).toContain('"id, title, cover_path, original_author, pen:public_pen_names(id, name)"');
    expect(choice).toContain('"id, title, cover_path, price_all, original_author, pen:public_pen_names(id, name)"');
    expect(readSrc("lib/librum-download-pages.ts")).toContain("original_author, published_at");
  });

  it("the wizard: the box, required with a public-domain choice on either button, back to step 1", () => {
    const source = readSrc("app/(public)/dashboard/books/new/upload-wizard.tsx");
    expect(source).toContain('name="originalAuthor"');
    expect(source).toContain('const originalAuthorRequired = rightsBasis === "public_domain" || rightsBasis === "public_domain_original";');
    expect(source).toMatch(/if \(originalAuthorRequired && !originalAuthor\.trim\(\)\) \{\s*event\.preventDefault\(\);\s*setOriginalAuthorError\(MISSING_ORIGINAL_AUTHOR_MESSAGE\);\s*setStep\(1\);/);
    expect(source).toContain("{ORIGINAL_AUTHOR_HINT}");
    // Before the rights check, so a public-domain draft is caught too.
    expect(source.indexOf("if (originalAuthorRequired && !originalAuthor.trim())")).toBeLessThan(
      source.indexOf("const rightsMissing = publishing"),
    );
  });

  it("the Edit page: the box, prefilled, kept in the draft fields, and opened when a public-domain book lacks one", () => {
    const source = readSrc("app/(public)/dashboard/books/[id]/edit/page.tsx");
    expect(source).toContain('name="originalAuthor"');
    expect(source).toContain('defaultValue={book.original_author ?? ""}');
    expect(source).toContain('"originalAuthor",');
    expect(source).toContain("!book.original_author");
  });

  it("the Word ebook's dc:creator follows a typed original author", () => {
    const source = readSrc("components/manuscript-field.tsx");
    expect(source).toContain('form?.elements.namedItem("originalAuthor")');
    expect(source).toContain("originalAuthorInput?.value.trim() || input?.value.trim() || authorName");
    expect(source).toContain('originalAuthorInput?.addEventListener("input", handlePenNameInput);');
  });
});

describe("BD3 patch 4 r2: staff see the original author (audit r1, M1)", () => {
  it("the admin book page and the books list read and show original_author", () => {
    const page = readSrc("app/admin/(protected)/books/[id]/page.tsx");
    expect(page).toContain("pen:pen_names(name), original_author");
    expect(page).toContain("Original author (readers see this as the byline):");
    const list = readSrc("app/admin/(protected)/books/page.tsx");
    expect(list).toContain("pen:pen_names(name), original_author");
    expect(list).toContain("original author: ${book.original_author}");
  });

  it("the book page reads the rights basis only for a book with an original author, and names the pen name only when allowed (H1)", () => {
    const source = readSrc("app/(public)/libra/[id]/page.tsx");
    expect(source).toContain("const rightsForBylinePromise = resolveOriginalAuthor(book)\n    ? readRightsBasisForPages(createAdminClient(), book.id)\n    : null;");
    expect(source).toContain("rightsForByline?.ok === true,");
    expect(source).toContain("{originalAuthor && translatorLine && (");
    expect(source).toContain("penIsTranslator,");
  });
});
