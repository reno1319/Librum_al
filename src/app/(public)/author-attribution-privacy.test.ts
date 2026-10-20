import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";

// LIBRUM 2.0 AUTHOR-1B / AUTHOR-1C: the explicit repo-wide privacy/
// contract sweep. Same source-level regression convention already
// established in this codebase (see book-detail-metadata.test.ts's own
// comment: no DOM-rendering harness exists for these Server Components)
// -- these assert directly against the real page/route/lib source text
// rather than a rendered DOM, which is exactly the boundary that
// actually matters here.
//
// AUTHOR-1C changed WHERE these files read author attribution from:
// every one of them (except lib/email.ts, which reads through the
// admin/service-role client -- unaffected by the RLS/grant changes,
// see its own describe block below) now queries the safe
// public_author_profiles database VIEW (migration 045), never the base
// profiles table, for any row that isn't the request's own signed-in
// user. That view physically has no display_name column, so a plain
// "does this file mention display_name" grep would be meaningless --
// what has to be true is narrower and checkable directly from source:
// every reader-facing render site resolves the name through
// resolvePublicAuthorName(), every reader-facing query targets
// public_author_profiles (aliased back to `profiles` in the select
// string, so property access needs no changes), and nothing ever
// interpolates a raw `.display_name` straight into rendered output, a
// title, a description, or an email.

function readSrc(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), "src", relativePath), "utf8");
}

// Every one of these is a genuine reader-facing author-attribution
// surface per the AUTHOR-1B brief (books/[id]/page.tsx's reviewer block
// and the reports/dashboard/account/admin identity displays are
// deliberately excluded -- see the classification list below this
// array).
const READER_FACING_ATTRIBUTION_FILES = [
  "app/(public)/bookstore/page.tsx",
  "components/book-shelf.tsx",
  "app/(public)/books/[id]/page.tsx",
  "app/(public)/authors/[id]/page.tsx",
  "app/(public)/series/[id]/page.tsx",
  "app/(public)/bundles/[id]/page.tsx",
  "app/(public)/library/page.tsx",
  "app/(public)/wishlist/page.tsx",
  "app/(public)/following/page.tsx",
  "app/api/books/[id]/sample/route.ts",
  "lib/email.ts",
];

// PEN-NAMES-1 (migration 20261019184512) supersedes the two AUTHOR-1B /
// AUTHOR-1C blocks that stood here: every reader-facing author name is
// now a PEN NAME, read through the public_pen_names view (no author_id,
// no account columns) -- or, for the follower email, from pen_names
// through the admin client. No reader-facing surface reads the
// account's public_author_name for an author byline any more; the one
// remaining public_author_profiles join is the reviewer name on the
// book page (out of scope, PR B).
describe("PEN-NAMES-1 privacy contract: every reader-facing author name is a pen name", () => {
  const viewFiles = READER_FACING_ATTRIBUTION_FILES.filter((file) => file !== "lib/email.ts" && file !== "components/book-shelf.tsx");

  it.each(viewFiles)("%s reads pen names through the public_pen_names view", (file) => {
    expect(readSrc(file)).toContain("public_pen_names");
  });

  it.each(READER_FACING_ATTRIBUTION_FILES)("%s never reads an author byline from public_author_profiles or resolvePublicAuthorName", (file) => {
    const source = readSrc(file);
    const authorJoins = (source.match(/public_author_profiles\(public_author_name[^)]*\)/g) ?? []).filter(
      (join) => join !== "public_author_profiles(public_author_name)" || file !== "app/(public)/books/[id]/page.tsx",
    );
    expect(authorJoins).toEqual([]);
    expect(source).not.toMatch(/\.from\("public_author_profiles"\)/);
    if (file !== "app/(public)/books/[id]/page.tsx") {
      const code = source
        .split("\n")
        .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
        .join("\n");
      expect(code).not.toMatch(/resolvePublicAuthorName\(/);
    }
  });

  it("components/book-shelf.tsx takes the embedded pen name (resolveBookByline)", () => {
    const source = readSrc("components/book-shelf.tsx");
    expect(source).toContain('from "@/lib/book-byline"');
    expect(source).toContain("resolveBookByline(book)");
    expect(source).toContain("pen: PenNameRef | null");
  });

  it("resolveBookByline is the embedded pen name only -- never an account name", () => {
    const source = readSrc("lib/book-byline.ts");
    expect(source).toContain('export const BOOK_PEN_NAME_EMBED = "pen:public_pen_names(id, name)";');
    expect(source).toContain("return book?.pen?.name ?? null;");
    expect(source).not.toContain("@/lib/author-name");
    expect(source).not.toMatch(/display_name|public_author_name/);
  });

  it("lib/email.ts names the book's pen name (admin client) and mails that pen name's followers", () => {
    const source = readSrc("lib/email.ts");
    expect(source).not.toContain("public_author_profiles");
    expect(source).toMatch(/\.from\("pen_names"\)/);
    expect(source).toMatch(/\.from\("pen_name_follows"\)/);
    expect(source).not.toMatch(/\.from\("author_follows"\)/);
  });

  it("no reader-facing page links to /authors/<account id> any more", () => {
    for (const file of READER_FACING_ATTRIBUTION_FILES) {
      expect(readSrc(file)).not.toMatch(/\/authors\/\$\{[a-zA-Z.?]*author_id\}/);
    }
    for (const file of ["components/book-card.tsx", "components/library-book-card.tsx"]) {
      expect(readSrc(file)).not.toMatch(/\/authors\/\$\{/);
      expect(readSrc(file)).toContain("authorPagePath(");
    }
  });
});

describe("AUTHOR-1B / AUTHOR-1C privacy contract: no raw .display_name render for author attribution", () => {
  // A `.display_name` PROPERTY READ (as opposed to a `select("...
  // display_name ...")` column-list string, which never has a leading
  // dot and is fine/required for the fallback) is not acceptable
  // anywhere in these files any more -- AUTHOR-1C's database-level fix
  // means none of these queries can even select display_name for
  // another user's row (public_author_profiles physically has no such
  // column, and the base table's own RLS blocks it), so there is no
  // longer a legitimate "self/admin exception" or "reviewer identity is
  // a separate concept" carve-out on THESE specific public/reader-facing
  // files the way earlier AUTHOR-1B reasoning allowed (that carve-out
  // still applies elsewhere -- dashboard/profile/page.tsx, account/
  // page.tsx, site-header.tsx -- see the dedicated describe block below
  // for those). A pure comment describing this history is still fine;
  // real code is not.
  it.each(READER_FACING_ATTRIBUTION_FILES)("%s never renders a raw .display_name property read for author attribution", (file) => {
    const source = readSrc(file);
    const lines = source.split("\n");
    const offendingLines = lines.filter((line) => {
      if (!/[a-zA-Z0-9_)\]?]\.display_name\b/.test(line)) return false;
      // A pure comment can describe the resolver's own fallback
      // behavior (mentioning "author.display_name" in prose) without
      // that being an actual render site -- only real code is checked.
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) return false;
      if (line.includes("resolvePublicAuthorName")) return false;
      if (line.includes("review.profiles")) return false;
      return true;
    });
    expect(offendingLines).toEqual([]);
  });
});

describe("AUTHOR-1C privacy contract: books/[id]/page.tsx's reviewer join no longer leaks a raw display_name either", () => {
  const source = readSrc("app/(public)/books/[id]/page.tsx");

  // LIBRUM 2.0 AUTHOR-1C superseded the AUTHOR-1B decision to leave the
  // reviewer join untouched: once the database itself no longer permits
  // an ordinary reader/anon query to read ANOTHER user's display_name at
  // all (see migration 045's profiles RLS policies), the reviewer join
  // can no longer request that column without a hard permission error
  // breaking the whole page -- and, independently, a pseudonymous author
  // who reviews another book as a reader would otherwise leak their real
  // display_name through this exact join. Both are now routed through
  // the same safe public_author_profiles view every author-attribution
  // join on this page uses.
  // PEN-NAMES-2 (22a): the reviewer join moved again, to public_reviews.
  // The view computes reviewer_name itself (the reviewer's default pen
  // name when they are an author with a book, else null -- the same rule
  // public_author_profiles applied) and carries no reader_id, so the page
  // can't tie a review to an account.
  it("reviews come from public_reviews with reviewer_name, and never select reader_id or a profiles join", () => {
    expect(source).toContain('.from("public_reviews")');
    expect(source).toContain('.select("id, book_id, rating, body, created_at, reviewer_name")');
    expect(source).not.toMatch(/profiles\(display_name\)/);
    expect(source).not.toMatch(/\.from\("public_reviews"\)\s*\.select\("[^"]*reader_id/);
  });

  it("review names show reviewer_name with a generic fallback, never a profiles field", () => {
    expect(source).toContain('review.reviewer_name ?? "A Librum reader"');
    expect(source).not.toMatch(/review\.profiles[^`]/); // the one hit left is a backticked comment
  });

  // PEN-NAMES-1: the book's own author block and both shelves read the
  // pen name view. PEN-NAMES-2: nothing on the page reads
  // public_author_profiles any more.
  it("every author-attribution select on this page reads the pen name view, never the base profiles table", () => {
    expect(source).toContain('.select("*, pen:public_pen_names(id, name, bio, avatar_path, links)")');
    const shelfSelects = source.match(/\.select\("\*, pen:public_pen_names\(id, name\)"\)/g) ?? [];
    expect(shelfSelects.length).toBe(2); // moreByAuthor + youMightLike
    expect(source).not.toMatch(/public_author_profiles\(/);
    expect(source).not.toMatch(/profiles\(display_name, public_author_name/);
  });
});

describe("AUTHOR-1B privacy contract: EPUB dc:creator is sourced from the resolved public name, not display_name", () => {
  const dashboardFiles = [
    "app/(public)/dashboard/books/new/page.tsx",
    "app/(public)/dashboard/books/[id]/edit/page.tsx",
  ];

  it.each(dashboardFiles)("%s selects public_author_name alongside display_name and resolves authorName via resolvePublicAuthorName", (file) => {
    const source = readSrc(file);
    expect(source).toContain('from "@/lib/author-name"');
    expect(source).toMatch(/public_author_name/);
    expect(source).toContain("authorName={resolvePublicAuthorName(profile)");
    // Never the pre-AUTHOR-1B raw read as the prop value.
    expect(source).not.toContain("authorName={profile?.display_name");
  });

  it("epub-generator.ts documents the durable-artifact / snapshot-at-generation-time contract at both dc:creator write sites", () => {
    const source = readSrc("lib/epub-generator.ts");
    // Matched narrowly on the actual write template (`${escapeXml(...)}`
    // interpolated into the tag) so patchEpubMetadata's own unrelated
    // `<dc:creator>[\s\S]*?</dc:creator>` MATCH regex (a read, not a
    // write) doesn't inflate the count to 3.
    const creatorWriteSites = source.split("<dc:creator>${escapeXml(");
    // Two write sites: renderOpf's own template literal, and
    // patchEpubMetadata's regex replacement -- both preceded by a
    // comment explaining an already-downloaded EPUB can't be
    // retroactively updated if the pen name later changes.
    expect(creatorWriteSites.length - 1).toBe(2);
    expect(source).toMatch(/durable-artifact|permanently part of an artifact/i);
    expect(source).toMatch(/snapshots?[\s\S]{0,40}generation time/i);
    expect(source).toContain("resolvePublicAuthorName(profile)");
  });
});

describe("AUTHOR-1B privacy contract: legitimate display_name uses that are deliberately NOT converted", () => {
  it("dashboard/profile/page.tsx still shows display_name as the editable Account name field itself (the source of the value, not reader attribution)", () => {
    const source = readSrc("app/(public)/dashboard/profile/page.tsx");
    expect(source).toContain("defaultValue={profile?.display_name}");
  });

  it("account/page.tsx shows the signed-in user their own display_name (private, self-facing identity, not shown to any other reader)", () => {
    const source = readSrc("app/(public)/account/page.tsx");
    expect(source).toContain("profile.display_name");
  });

  it("site-header.tsx shows the signed-in user their own display_name in the header greeting (self-facing only)", () => {
    const source = readSrc("components/site-header.tsx");
    expect(source).toContain("profile?.display_name");
  });
});
