// ACCOUNT-DELETION-BOOK-STORAGE-AUTH-1: test-only data shared by
// src/lib/book-storage-path.test.ts and src/app/(public)/account/
// book-storage-deletion.test.ts, so the rule and the privileged remover
// are exercised against the same hostile values. Imported by no
// application code.
import { BOOK_COVERS_BUCKET, BOOK_MANUSCRIPTS_BUCKET } from "./book-storage-path";

export const BOOK_FIXTURE_AUTHOR_ID = "a1b2c3d4-3333-4333-8333-abcdef333333";
export const BOOK_FIXTURE_OTHER_AUTHOR_ID = "b2c3d4e5-4444-4444-8444-abcdef444444";
export const BOOK_FIXTURE_BOOK_ID = "c3d4e5f6-5555-4555-8555-abcdef555555";
export const BOOK_FIXTURE_OTHER_BOOK_ID = "d4e5f6a7-6666-4666-8666-abcdef666666";

const AUTHOR = BOOK_FIXTURE_AUTHOR_ID;
const OTHER_AUTHOR = BOOK_FIXTURE_OTHER_AUTHOR_ID;
const BOOK = BOOK_FIXTURE_BOOK_ID;
const OTHER_BOOK = BOOK_FIXTURE_OTHER_BOOK_ID;

// Hostile values shared by both kinds of key, given the canonical file
// name for BOOK (`${BOOK}-cover.png` or `${BOOK}.epub`) and the same file
// name built for OTHER_BOOK.
function sharedUnsafe(file: string, otherBookFile: string, bucket: string, tmpFolder: string): [string, unknown][] {
  const own = `${AUTHOR}/${file}`;
  return [
    ["empty", ""],
    ["whitespace", "   "],
    ["another author's otherwise canonical key for this book id", `${OTHER_AUTHOR}/${file}`],
    ["another author's canonical key for their own book", `${OTHER_AUTHOR}/${otherBookFile}`],
    ["this author's canonical key for another book", `${AUTHOR}/${otherBookFile}`],
    ["author prefix confusion: longer first segment", `${AUTHOR}x/${file}`],
    ["author prefix confusion: truncated author id", `${AUTHOR.slice(0, -1)}/${file}`],
    ["author prefix confusion: id glued to the file name", `${AUTHOR}${file}`],
    ["author prefix confusion: other author after own", `${AUTHOR}/${OTHER_AUTHOR}/${file}`],
    ["author prefix confusion: own id nested under other", `${OTHER_AUTHOR}/${AUTHOR}/${file}`],
    ["book-id prefix confusion: longer book id", `${AUTHOR}/${BOOK}0${file.slice(BOOK.length)}`],
    ["book-id prefix confusion: truncated book id", `${AUTHOR}/${BOOK.slice(0, -1)}${file.slice(BOOK.length)}`],
    ["book-id prefix confusion: other book id glued on", `${AUTHOR}/${BOOK}${otherBookFile}`],
    ["traversal to another author", `${AUTHOR}/../${OTHER_AUTHOR}/${file}`],
    ["traversal to another book", `${AUTHOR}/../${AUTHOR}/${otherBookFile}`],
    ["dot segment", `${AUTHOR}/./${file}`],
    ["encoded traversal", `${AUTHOR}/..%2F${OTHER_AUTHOR}/${file}`],
    ["double-encoded traversal", `${AUTHOR}/%252e%252e%252f${OTHER_AUTHOR}/${file}`],
    ["encoded slash", `${AUTHOR}%2F${file}`],
    ["double-encoded slash", `${AUTHOR}%252F${file}`],
    ["backslash separator", `${AUTHOR}\\${file}`],
    ["backslash traversal", `${AUTHOR}\\..\\${OTHER_AUTHOR}\\${file}`],
    ["leading slash", `/${own}`],
    ["leading dot-slash", `./${own}`],
    ["double slash", `${AUTHOR}//${file}`],
    ["trailing slash", `${own}/`],
    ["bucket-qualified", `${bucket}/${own}`],
    ["storage-API-qualified", `storage/v1/object/${bucket}/${own}`],
    ["wrong bucket prefix", `${bucket === BOOK_COVERS_BUCKET ? BOOK_MANUSCRIPTS_BUCKET : BOOK_COVERS_BUCKET}/${own}`],
    ["temporary upload key", `${AUTHOR}/tmp/${tmpFolder}/${file}`],
    ["extra depth", `${AUTHOR}/a/${file}`],
    ["no folder", file],
    ["folder only", `${AUTHOR}/`],
    ["bare author id", AUTHOR],
    ["upper-case author id", `${AUTHOR.toUpperCase()}/${file}`],
    ["upper-case book id", `${AUTHOR}/${BOOK.toUpperCase()}${file.slice(BOOK.length)}`],
    ["query suffix", `${own}?x=1`],
    ["fragment suffix", `${own}#x`],
    ["NUL byte", `${own}\u0000`],
    ["embedded NUL", `${AUTHOR}/\u0000${file}`],
    ["trailing newline", `${own}\n`],
    ["embedded newline", `${AUTHOR}/\n${file}`],
    ["carriage return", `${own}\r`],
    ["tab", `${own}\t`],
    ["leading space", ` ${own}`],
    ["trailing space", `${own} `],
    ["unicode lookalike slash", `${AUTHOR}∕${file}`],
    ["full URL", `https://example.supabase.co/storage/v1/object/public/${bucket}/${own}`],
    ["number", 42],
    ["boolean", true],
    ["array holding the canonical key", [own]],
    ["object", { path: own }],
    ["undefined", undefined],
  ];
}

// Every stored cover_path deleteAccount must refuse to hand to
// service-role removal for AUTHOR's BOOK, as [label, value]. `null` is
// deliberately absent: it is "no cover", not an unsafe value.
export const UNSAFE_COVER_PATHS: [string, unknown][] = [
  ...sharedUnsafe(`${BOOK}-cover.png`, `${OTHER_BOOK}-cover.png`, BOOK_COVERS_BUCKET, "cover"),
  ["jpeg spelling", `${AUTHOR}/${BOOK}-cover.jpeg`],
  ["upper-case extension PNG", `${AUTHOR}/${BOOK}-cover.PNG`],
  ["upper-case extension JPG", `${AUTHOR}/${BOOK}-cover.JPG`],
  ["mixed-case extension", `${AUTHOR}/${BOOK}-cover.Png`],
  ["unsupported extension gif", `${AUTHOR}/${BOOK}-cover.gif`],
  ["unsupported extension webp", `${AUTHOR}/${BOOK}-cover.webp`],
  ["svg", `${AUTHOR}/${BOOK}-cover.svg`],
  ["no extension", `${AUTHOR}/${BOOK}-cover`],
  ["double extension", `${AUTHOR}/${BOOK}-cover.png.png`],
  ["manuscript key in the cover column", `${AUTHOR}/${BOOK}.epub`],
  ["missing -cover suffix", `${AUTHOR}/${BOOK}.png`],
  ["upper-case -COVER", `${AUTHOR}/${BOOK}-COVER.png`],
  ["underscore cover", `${AUTHOR}/${BOOK}_cover.png`],
  ["avatar key", `${AUTHOR}/avatar.png`],
  ["temporary cover upload", `${AUTHOR}/tmp/cover/${OTHER_BOOK}.png`],
];

// The same, for a stored file_path.
export const UNSAFE_MANUSCRIPT_PATHS: [string, unknown][] = [
  ...sharedUnsafe(`${BOOK}.epub`, `${OTHER_BOOK}.epub`, BOOK_MANUSCRIPTS_BUCKET, "epub"),
  ["upper-case extension", `${AUTHOR}/${BOOK}.EPUB`],
  ["mixed-case extension", `${AUTHOR}/${BOOK}.Epub`],
  ["unsupported extension pdf", `${AUTHOR}/${BOOK}.pdf`],
  ["docx", `${AUTHOR}/${BOOK}.docx`],
  ["no extension", `${AUTHOR}/${BOOK}`],
  ["double extension", `${AUTHOR}/${BOOK}.epub.epub`],
  ["cover key in the manuscript column", `${AUTHOR}/${BOOK}-cover.png`],
  ["cover-suffixed epub", `${AUTHOR}/${BOOK}-cover.epub`],
  ["temporary epub upload", `${AUTHOR}/tmp/epub/${OTHER_BOOK}.epub`],
  ["temporary docx upload", `${AUTHOR}/tmp/docx/${OTHER_BOOK}.docx`],
];
