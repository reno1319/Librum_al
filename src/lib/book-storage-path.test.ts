import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BOOK_COVER_EXTENSIONS,
  BOOK_COVERS_BUCKET,
  BOOK_MANUSCRIPTS_BUCKET,
  canonicalBookCoverPath,
  canonicalBookManuscriptPath,
  classifyBookCoverPath,
  groupBookStorageRemovals,
  isOwnCanonicalBookCoverPath,
  isOwnCanonicalBookManuscriptPath,
  isOwnRemovableBookCoverPath,
  isOwnTemporaryCoverUploadPath,
  isOwnTemporaryManuscriptUploadPath,
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

// BOOK-STORAGE-MUTATION-AUTH-1: the writers no longer build these keys
// inline -- createBook and updateBook call the constructors above, so
// the rule and the writers cannot drift apart. This pins that no inline
// book-key template survives anywhere in the book actions.
describe("writers use the shared constructors, never an inline key template", () => {
  const source = readFileSync(join(process.cwd(), "src/app/(public)/dashboard/books/actions.ts"), "utf8");

  it("no inline cover or manuscript key template remains", () => {
    expect(source).not.toMatch(/`\$\{[^}]+\}\/\$\{[^}]+\}-cover\./);
    expect(source).not.toMatch(/`\$\{[^}]+\}\/\$\{[^}]+\}\.epub`/);
  });

  it("createBook and updateBook each build both keys with the constructors", () => {
    const create = source.slice(source.indexOf("export async function createBook("), source.indexOf("export async function updateBook("));
    const update = source.slice(source.indexOf("export async function updateBook("), source.indexOf("async function performPublish("));
    expect(create).toMatch(/canonicalBookCoverPath\(user\.id, bookId, coverResult\.extension\)/);
    expect(create).toMatch(/canonicalBookManuscriptPath\(user\.id, bookId\)/);
    expect(update).toMatch(/canonicalBookCoverPath\(user\.id, existing\.id, coverResult\.extension\)/);
    expect(update).toMatch(/canonicalBookManuscriptPath\(user\.id, existing\.id\)/);
  });
});

// The legacy cover form the rule recognises: the exact own-book stem
// `<author>/<book>-cover.` followed by "jpeg" in any ASCII case. Stage A
// counted such a row only through lower(), so its raw spelling is not
// known; every case permutation of those four letters is accepted.
const LEGACY_JPEG = `${AUTHOR}/${BOOK}-cover.jpeg`;
const JPEG_SPELLINGS = Array.from({ length: 16 }, (_, mask) =>
  [..."jpeg"].map((c, i) => (mask & (1 << i) ? c.toUpperCase() : c)).join(""),
);

describe("classifyBookCoverPath", () => {
  it.each(["png", "jpg"])("classifies the book's own canonical .%s cover as canonical", (ext) => {
    expect(classifyBookCoverPath(`${AUTHOR}/${BOOK}-cover.${ext}`, AUTHOR, BOOK)).toBe("canonical");
  });

  it("there are exactly 16 ASCII spellings of jpeg under test, all distinct", () => {
    expect(new Set(JPEG_SPELLINGS).size).toBe(16);
    expect(JPEG_SPELLINGS).toContain("jpeg");
    expect(JPEG_SPELLINGS).toContain("JPEG");
    expect(JPEG_SPELLINGS).toContain("Jpeg");
  });

  it.each(JPEG_SPELLINGS)("classifies the exact own-book .%s cover as legacy (removable, never canonical)", (ext) => {
    const path = `${AUTHOR}/${BOOK}-cover.${ext}`;
    expect(classifyBookCoverPath(path, AUTHOR, BOOK)).toBe("legacy");
    expect(isOwnRemovableBookCoverPath(path, AUTHOR, BOOK)).toBe(true);
    expect(isOwnCanonicalBookCoverPath(path, AUTHOR, BOOK)).toBe(false);
  });

  it.each(JPEG_SPELLINGS)("binds the legacy .%s form to the exact author and book", (ext) => {
    const own = `${AUTHOR}/${BOOK}-cover.${ext}`;
    expect(classifyBookCoverPath(own, AUTHOR, OTHER_BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(own, OTHER_AUTHOR, BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(`${AUTHOR}/${OTHER_BOOK}-cover.${ext}`, AUTHOR, BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(`${OTHER_AUTHOR}/${BOOK}-cover.${ext}`, AUTHOR, BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(`${AUTHOR}/../${AUTHOR}/${BOOK}-cover.${ext}`, AUTHOR, BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(`${AUTHOR.toUpperCase()}/${BOOK}-cover.${ext}`, AUTHOR, BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(`${AUTHOR}/${BOOK.toUpperCase()}-cover.${ext}`, AUTHOR, BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(`covers/${own}`, AUTHOR, BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(`https://x.supabase.co/storage/v1/object/public/covers/${own}`, AUTHOR, BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(`${AUTHOR}%2F${BOOK}-cover.${ext}`, AUTHOR, BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(`${own}.${ext}`, AUTHOR, BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(`${own}.png`, AUTHOR, BOOK)).toBe("unsafe");
  });

  it.each([
    ["upper-case JPG (canonical .jpg is not widened)", `${AUTHOR}/${BOOK}-cover.JPG`],
    ["upper-case PNG (canonical .png is not widened)", `${AUTHOR}/${BOOK}-cover.PNG`],
    ["upper-case -COVER", `${AUTHOR}/${BOOK}-COVER.jpeg`],
    ["jpe", `${AUTHOR}/${BOOK}-cover.jpe`],
    ["jpegg", `${AUTHOR}/${BOOK}-cover.jpegg`],
    ["jpeg with trailing space", `${LEGACY_JPEG} `],
    ["jpeg with trailing newline", `${LEGACY_JPEG}\n`],
    ["jpeg with NUL", `${LEGACY_JPEG}\u0000`],
    ["jpeg with query", `${LEGACY_JPEG}?x=1`],
    ["encoded jpeg letter", `${AUTHOR}/${BOOK}-cover.%6Apeg`],
    ["fullwidth j", `${AUTHOR}/${BOOK}-cover.\uff4apeg`],
    ["Cyrillic e lookalike", `${AUTHOR}/${BOOK}-cover.jp\u0435g`],
    ["jpeg with traversal", `${AUTHOR}/../${AUTHOR}/${BOOK}-cover.jpeg`],
    ["jpeg bucket-prefixed", `covers/${LEGACY_JPEG}`],
    ["jpeg with leading slash", `/${LEGACY_JPEG}`],
    ["jpeg percent-encoded", `${AUTHOR}%2F${BOOK}-cover.jpeg`],
    ["jpeg upper-case book id", `${AUTHOR}/${BOOK.toUpperCase()}-cover.jpeg`],
    ["jpeg double extension", `${LEGACY_JPEG}.jpeg`],
    ["jpeg extra depth", `${AUTHOR}/x/${BOOK}-cover.jpeg`],
    ["jpeg temp namespace", `${AUTHOR}/tmp/cover/${BOOK}-cover.jpeg`],
  ])("never extends the legacy form: %s is unsafe", (_label, value) => {
    expect(classifyBookCoverPath(value, AUTHOR, BOOK)).toBe("unsafe");
  });

  it.each(UNSAFE_COVER_PATHS.filter(([, value]) => value !== LEGACY_JPEG))("classifies %s as unsafe", (_label, value) => {
    expect(classifyBookCoverPath(value, AUTHOR, BOOK)).toBe("unsafe");
    expect(isOwnRemovableBookCoverPath(value, AUTHOR, BOOK)).toBe(false);
  });

  it("classifies null as unsafe", () => {
    expect(classifyBookCoverPath(null, AUTHOR, BOOK)).toBe("unsafe");
  });

  it.each([...MALFORMED_IDS, null, undefined, 42])("classifies everything as unsafe for a malformed id %j", (id) => {
    const s = String(id);
    expect(classifyBookCoverPath(`${s}/${BOOK}-cover.jpeg`, id, BOOK)).toBe("unsafe");
    expect(classifyBookCoverPath(`${AUTHOR}/${s}-cover.jpeg`, AUTHOR, id)).toBe("unsafe");
  });

  it("no constructor can produce the legacy form", () => {
    expect(() => canonicalBookCoverPath(AUTHOR, BOOK, "jpeg" as never)).toThrow();
  });
});

describe("temporary upload keys", () => {
  const T = "e5f6a7b8-7777-4777-8777-abcdef777777";

  it("accept exactly <author>/tmp/epub/<uuid>.epub and <author>/tmp/cover/<uuid>.<jpg|png>", () => {
    expect(isOwnTemporaryManuscriptUploadPath(`${AUTHOR}/tmp/epub/${T}.epub`, AUTHOR)).toBe(true);
    expect(isOwnTemporaryCoverUploadPath(`${AUTHOR}/tmp/cover/${T}.png`, AUTHOR)).toBe(true);
    expect(isOwnTemporaryCoverUploadPath(`${AUTHOR}/tmp/cover/${T}.jpg`, AUTHOR)).toBe(true);
  });

  it.each([
    ["another author", `${OTHER_AUTHOR}/tmp/epub/${T}.epub`],
    ["traversal out of tmp", `${AUTHOR}/tmp/epub/../../${OTHER_AUTHOR}/${BOOK}.epub`],
    ["traversal inside the file name", `${AUTHOR}/tmp/epub/../${T}.epub`],
    ["repeated dots", `${AUTHOR}/tmp/epub/${T}..epub`],
    ["leading slash", `/${AUTHOR}/tmp/epub/${T}.epub`],
    ["backslash", `${AUTHOR}\\tmp\\epub\\${T}.epub`],
    ["percent-encoded slash", `${AUTHOR}/tmp/epub%2F${T}.epub`],
    ["URL", `https://x.supabase.co/storage/v1/object/manuscripts/${AUTHOR}/tmp/epub/${T}.epub`],
    ["bucket-prefixed", `manuscripts/${AUTHOR}/tmp/epub/${T}.epub`],
    ["non-uuid name", `${AUTHOR}/tmp/epub/x.epub`],
    ["upper-case uuid", `${AUTHOR}/tmp/epub/${T.toUpperCase()}.epub`],
    ["upper-case extension", `${AUTHOR}/tmp/epub/${T}.EPUB`],
    ["extra depth", `${AUTHOR}/tmp/epub/a/${T}.epub`],
    ["docx namespace", `${AUTHOR}/tmp/docx/${T}.epub`],
    ["cover namespace", `${AUTHOR}/tmp/cover/${T}.epub`],
    ["permanent manuscript key", `${AUTHOR}/${BOOK}.epub`],
    ["NUL byte", `${AUTHOR}/tmp/epub/${T}.epub\u0000`],
    ["trailing newline", `${AUTHOR}/tmp/epub/${T}.epub\n`],
    ["empty", ""],
    ["null", null],
  ])("the manuscript temp rule refuses %s", (_label, value) => {
    expect(isOwnTemporaryManuscriptUploadPath(value, AUTHOR)).toBe(false);
  });

  it.each([
    ["another author", `${OTHER_AUTHOR}/tmp/cover/${T}.png`],
    ["jpeg spelling", `${AUTHOR}/tmp/cover/${T}.jpeg`],
    ["upper-case PNG", `${AUTHOR}/tmp/cover/${T}.PNG`],
    ["traversal", `${AUTHOR}/tmp/cover/../../${OTHER_AUTHOR}/${BOOK}-cover.png`],
    ["epub namespace", `${AUTHOR}/tmp/epub/${T}.png`],
    ["non-uuid name", `${AUTHOR}/tmp/cover/abc.png`],
    ["permanent cover key", `${AUTHOR}/${BOOK}-cover.png`],
    ["empty", ""],
  ])("the cover temp rule refuses %s", (_label, value) => {
    expect(isOwnTemporaryCoverUploadPath(value, AUTHOR)).toBe(false);
  });

  it.each([...MALFORMED_IDS, null, undefined])("accepts nothing for a malformed author id %j", (id) => {
    expect(isOwnTemporaryManuscriptUploadPath(`${String(id)}/tmp/epub/${T}.epub`, id)).toBe(false);
    expect(isOwnTemporaryCoverUploadPath(`${String(id)}/tmp/cover/${T}.png`, id)).toBe(false);
  });
});

describe("groupBookStorageRemovals", () => {
  it("de-duplicates per bucket, keeps first-seen order, and never merges buckets", () => {
    expect(
      groupBookStorageRemovals([
        { bucket: "covers", path: "a" },
        { bucket: "manuscripts", path: "a" },
        { bucket: "covers", path: "a" },
        { bucket: "manuscripts", path: "b" },
        { bucket: "manuscripts", path: "a" },
      ]),
    ).toEqual([
      ["covers", ["a"]],
      ["manuscripts", ["a", "b"]],
    ]);
  });

  it("produces nothing for no candidates", () => {
    expect(groupBookStorageRemovals([])).toEqual([]);
  });
});
