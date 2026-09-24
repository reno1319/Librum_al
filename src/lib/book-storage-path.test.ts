import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOK_COVER_EXTENSIONS,
  BOOK_COVERS_BUCKET,
  BOOK_MANUSCRIPTS_BUCKET,
  canonicalBookCoverPath,
  canonicalBookManuscriptPath,
  isOwnCanonicalBookCoverPath,
  isOwnCanonicalBookManuscriptPath,
} from "./book-storage-path";
import {
  BOOK_FIXTURE_AUTHOR_ID as AUTHOR,
  BOOK_FIXTURE_BOOK_ID as BOOK,
  BOOK_FIXTURE_OTHER_AUTHOR_ID as OTHER_AUTHOR,
  BOOK_FIXTURE_OTHER_BOOK_ID as OTHER_BOOK,
  UNSAFE_COVER_PATHS,
  UNSAFE_MANUSCRIPT_PATHS,
} from "./book-storage-path-test-fixtures";
import { resolveVerifiedCoverStorageDetails } from "./cover-image";

// ACCOUNT-DELETION-BOOK-STORAGE-AUTH-1: the canonical permanent book key
// rule used by deleteAccount's service-role cleanup.

const MALFORMED_IDS = ["", "author-1", AUTHOR.toUpperCase(), `${AUTHOR}/x`, `../${AUTHOR}`, `${AUTHOR} `, `${AUTHOR}\n`];

describe("canonicalBookCoverPath / canonicalBookManuscriptPath", () => {
  it("build <author id>/<book id>-cover.<jpg|png> and <author id>/<book id>.epub", () => {
    expect(canonicalBookCoverPath(AUTHOR, BOOK, "png")).toBe(`${AUTHOR}/${BOOK}-cover.png`);
    expect(canonicalBookCoverPath(AUTHOR, BOOK, "jpg")).toBe(`${AUTHOR}/${BOOK}-cover.jpg`);
    expect(canonicalBookManuscriptPath(AUTHOR, BOOK)).toBe(`${AUTHOR}/${BOOK}.epub`);
  });

  it.each(MALFORMED_IDS)("refuse a malformed author id %j", (id) => {
    expect(() => canonicalBookCoverPath(id, BOOK, "png")).toThrow();
    expect(() => canonicalBookManuscriptPath(id, BOOK)).toThrow();
  });

  it.each(MALFORMED_IDS)("refuse a malformed book id %j", (id) => {
    expect(() => canonicalBookCoverPath(AUTHOR, id, "png")).toThrow();
    expect(() => canonicalBookManuscriptPath(AUTHOR, id)).toThrow();
  });

  it.each(["jpeg", "gif", "PNG", "JPG", "webp", ""])("refuse unsupported cover extension %j", (ext) => {
    expect(() => canonicalBookCoverPath(AUTHOR, BOOK, ext as never)).toThrow();
  });

  it("buckets are covers and manuscripts", () => {
    expect(BOOK_COVERS_BUCKET).toBe("covers");
    expect(BOOK_MANUSCRIPTS_BUCKET).toBe("manuscripts");
  });

  it("cover extensions are exactly the ones the verified-signature resolver produces", () => {
    const produced = new Set([
      resolveVerifiedCoverStorageDetails("jpeg").extension,
      resolveVerifiedCoverStorageDetails("png").extension,
    ]);
    expect([...produced].sort()).toEqual([...BOOK_COVER_EXTENSIONS].sort());
  });
});

describe("isOwnCanonicalBookCoverPath", () => {
  it.each(["png", "jpg"])("accepts exactly the book's own canonical .%s cover", (ext) => {
    expect(isOwnCanonicalBookCoverPath(`${AUTHOR}/${BOOK}-cover.${ext}`, AUTHOR, BOOK)).toBe(true);
  });

  it.each(UNSAFE_COVER_PATHS)("rejects %s", (_label, value) => {
    expect(isOwnCanonicalBookCoverPath(value, AUTHOR, BOOK)).toBe(false);
  });

  it("rejects null", () => {
    expect(isOwnCanonicalBookCoverPath(null, AUTHOR, BOOK)).toBe(false);
  });

  it("is bound to both the author and the book", () => {
    expect(isOwnCanonicalBookCoverPath(`${OTHER_AUTHOR}/${OTHER_BOOK}-cover.png`, OTHER_AUTHOR, OTHER_BOOK)).toBe(true);
    expect(isOwnCanonicalBookCoverPath(`${OTHER_AUTHOR}/${OTHER_BOOK}-cover.png`, AUTHOR, OTHER_BOOK)).toBe(false);
    expect(isOwnCanonicalBookCoverPath(`${OTHER_AUTHOR}/${OTHER_BOOK}-cover.png`, OTHER_AUTHOR, BOOK)).toBe(false);
    expect(isOwnCanonicalBookCoverPath(`${AUTHOR}/${BOOK}-cover.png`, AUTHOR, OTHER_BOOK)).toBe(false);
    expect(isOwnCanonicalBookCoverPath(`${AUTHOR}/${BOOK}-cover.png`, OTHER_AUTHOR, BOOK)).toBe(false);
  });

  it.each([...MALFORMED_IDS, null, undefined, 42, [AUTHOR]])(
    "never accepts anything for a malformed author or book id %j",
    (id) => {
      const s = String(id);
      expect(isOwnCanonicalBookCoverPath(`${s}/${BOOK}-cover.png`, id, BOOK)).toBe(false);
      expect(isOwnCanonicalBookCoverPath(`${AUTHOR}/${s}-cover.png`, AUTHOR, id)).toBe(false);
    },
  );
});

describe("isOwnCanonicalBookManuscriptPath", () => {
  it("accepts exactly the book's own canonical manuscript", () => {
    expect(isOwnCanonicalBookManuscriptPath(`${AUTHOR}/${BOOK}.epub`, AUTHOR, BOOK)).toBe(true);
  });

  it.each(UNSAFE_MANUSCRIPT_PATHS)("rejects %s", (_label, value) => {
    expect(isOwnCanonicalBookManuscriptPath(value, AUTHOR, BOOK)).toBe(false);
  });

  it("rejects null", () => {
    expect(isOwnCanonicalBookManuscriptPath(null, AUTHOR, BOOK)).toBe(false);
  });

  it("is bound to both the author and the book", () => {
    expect(isOwnCanonicalBookManuscriptPath(`${OTHER_AUTHOR}/${OTHER_BOOK}.epub`, OTHER_AUTHOR, OTHER_BOOK)).toBe(true);
    expect(isOwnCanonicalBookManuscriptPath(`${OTHER_AUTHOR}/${OTHER_BOOK}.epub`, AUTHOR, OTHER_BOOK)).toBe(false);
    expect(isOwnCanonicalBookManuscriptPath(`${OTHER_AUTHOR}/${OTHER_BOOK}.epub`, OTHER_AUTHOR, BOOK)).toBe(false);
    expect(isOwnCanonicalBookManuscriptPath(`${AUTHOR}/${BOOK}.epub`, AUTHOR, OTHER_BOOK)).toBe(false);
    expect(isOwnCanonicalBookManuscriptPath(`${AUTHOR}/${BOOK}.epub`, OTHER_AUTHOR, BOOK)).toBe(false);
  });

  it.each([...MALFORMED_IDS, null, undefined, 42, [AUTHOR]])(
    "never accepts anything for a malformed author or book id %j",
    (id) => {
      const s = String(id);
      expect(isOwnCanonicalBookManuscriptPath(`${s}/${BOOK}.epub`, id, BOOK)).toBe(false);
      expect(isOwnCanonicalBookManuscriptPath(`${AUTHOR}/${s}.epub`, AUTHOR, id)).toBe(false);
    },
  );
});

// Drift alarm, not an authorization test: the writers (createBook and
// updateBook) still build these keys inline, and Patch 10 deliberately
// does not modify them. If either template changes, this rule must be
// revisited, or deleteAccount would start orphaning (never over-deleting)
// newly written objects.
describe("writer templates still match this rule", () => {
  const source = readFileSync(join(process.cwd(), "src/app/(public)/dashboard/books/actions.ts"), "utf8");

  it("covers: createBook and updateBook build <user.id>/<bookId>-cover.<verified extension>", () => {
    expect(source.match(/`\$\{user\.id\}\/\$\{bookId\}-cover\.\$\{coverResult\.extension\}`/g)).toHaveLength(2);
  });

  it("manuscripts: createBook and updateBook build <user.id>/<bookId>.epub", () => {
    expect(source.match(/`\$\{user\.id\}\/\$\{bookId\}\.epub`/g)).toHaveLength(2);
  });
});
