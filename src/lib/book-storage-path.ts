// ACCOUNT-DELETION-BOOK-STORAGE-AUTH-1: the ONE definition of a book's
// permanent Storage keys, used by the code that removes them with
// service-role authority (deleteAccount). It mirrors exactly what
// createBook and updateBook write today (src/app/(public)/dashboard/
// books/actions.ts):
//
//   covers bucket:      <author id>/<book id>-cover.<jpg|png>
//   manuscripts bucket: <author id>/<book id>.epub
//
// -- the lowercase UUID the Supabase session verified, then the book's
// own lowercase UUID, then either "-cover." plus the extension taken from
// the image's verified byte signature (src/lib/cover-image.ts:
// resolveVerifiedCoverStorageDetails) or the fixed ".epub". Nothing else
// is canonical: no other folder depth, no other file name, no other
// extension (not "jpeg", not upper case), no bucket prefix, no temporary
// upload key, no encoding, no whitespace.
//
// The check is an exact string comparison against the paths built from
// the caller's own author id and that row's own book id, never a parse
// of the stored value, so traversal ("../"), percent-encoding, prefix
// confusion ("<id>x/…", "<book id>0-cover.png"), another author's key and
// another book's key can never be accepted. A value this rejects is left
// in place: an orphaned object is always preferable to deleting someone
// else's file.

export const BOOK_COVERS_BUCKET = "covers";
export const BOOK_MANUSCRIPTS_BUCKET = "manuscripts";

export const BOOK_COVER_EXTENSIONS = ["jpg", "png"] as const;
export type BookCoverExtension = (typeof BOOK_COVER_EXTENSIONS)[number];

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertIds(caller: string, authorId: string, bookId: string): void {
  if (!UUID_PATTERN.test(authorId)) {
    throw new Error(`${caller}: author id is not a lowercase UUID`);
  }
  if (!UUID_PATTERN.test(bookId)) {
    throw new Error(`${caller}: book id is not a lowercase UUID`);
  }
}

// Builds the canonical cover key. Throws on anything but two lowercase
// UUIDs and a supported extension, so a malformed identity can never
// produce a path.
export function canonicalBookCoverPath(
  authorId: string,
  bookId: string,
  extension: BookCoverExtension,
): string {
  assertIds("canonicalBookCoverPath", authorId, bookId);
  if (!(BOOK_COVER_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new Error("canonicalBookCoverPath: unsupported cover extension");
  }
  return `${authorId}/${bookId}-cover.${extension}`;
}

// Builds the canonical manuscript key, under the same identity rules.
export function canonicalBookManuscriptPath(authorId: string, bookId: string): string {
  assertIds("canonicalBookManuscriptPath", authorId, bookId);
  return `${authorId}/${bookId}.epub`;
}

function idsAreCanonical(authorId: unknown, bookId: unknown): authorId is string {
  return (
    typeof authorId === "string" &&
    typeof bookId === "string" &&
    UUID_PATTERN.test(authorId) &&
    UUID_PATTERN.test(bookId)
  );
}

// True only when `path` is exactly one of the canonical cover keys for
// this author's own `bookId`. Any other value -- null, empty, another
// author's or another book's key, a legacy or hand-written value -- is
// false, and callers holding privileged Storage authority must then not
// touch it.
export function isOwnCanonicalBookCoverPath(
  path: unknown,
  authorId: unknown,
  bookId: unknown,
): path is string {
  if (typeof path !== "string" || !idsAreCanonical(authorId, bookId)) {
    return false;
  }
  return BOOK_COVER_EXTENSIONS.some(
    (extension) => path === canonicalBookCoverPath(authorId, bookId as string, extension),
  );
}

// True only when `path` is exactly the canonical manuscript key for this
// author's own `bookId`.
export function isOwnCanonicalBookManuscriptPath(
  path: unknown,
  authorId: unknown,
  bookId: unknown,
): path is string {
  if (typeof path !== "string" || !idsAreCanonical(authorId, bookId)) {
    return false;
  }
  return path === canonicalBookManuscriptPath(authorId, bookId as string);
}
