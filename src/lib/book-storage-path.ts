// ACCOUNT-DELETION-BOOK-STORAGE-AUTH-1: the ONE definition of a book's
// permanent Storage keys, used by the code that removes them with
// service-role authority (deleteAccount) and, since BOOK-STORAGE-
// MUTATION-AUTH-1, by the only writers of those keys: createBook and
// updateBook build them with the constructors below, and updateBook and
// deleteBook decide what they may remove with the classifiers below
// (src/app/(public)/dashboard/books/actions.ts):
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

// BOOK-STORAGE-MUTATION-AUTH-1: the documented legacy cover form. Before
// cover extensions were derived from the verified byte signature
// (LAUNCH-1 P3-1, see updateBook's own comment on the pre-hardening
// forms) a cover could be stored with a "jpeg" extension. Production
// Stage A (2026-09-25) counted one row whose cover_path, compared with
// lower(), equals `<its author id>/<its book id>-cover.jpeg`; the raw
// spelling of that extension was not disclosed, so the rule accepts the
// four letters "jpeg" in any ASCII case and nothing else:
//
//   `<author id>/<book id>-cover.` exactly (lowercase UUIDs, lowercase
//   "-cover."), then exactly four characters, each one ASCII j/J, p/P,
//   e/E, g/G in that order -- no other extension, no suffix, no extra
//   depth, no encoding, no whitespace.
//
// It is recognised ONLY so the book's own author can preserve, replace
// or delete that exact object, and callers remove the stored value
// byte-for-byte, never a lowercased reconstruction. No constructor here
// can produce it, so it can never become the key of a new write, and the
// canonical ".jpg"/".png" rule is not widened by it.
const LEGACY_BOOK_COVER_EXTENSION = /^[jJ][pP][eE][gG]$/;

// BOOK-STORAGE-MUTATION-AUTH-1: how a stored cover_path relates to one
// exact author and book.
//   canonical: exactly `<author id>/<book id>-cover.<jpg|png>`;
//   legacy:    exactly `<author id>/<book id>-cover.` + "jpeg" in any
//              ASCII case;
//   unsafe:    everything else -- null, empty, another author's or
//              another book's key, traversal, encoding, a bucket or URL
//              prefix, a temporary upload key, a malformed id.
// Only "canonical" and "legacy" may ever reach a Storage call, and only
// for the author and book they were classified against.
export type BookCoverPathClass = "canonical" | "legacy" | "unsafe";

export function classifyBookCoverPath(
  path: unknown,
  authorId: unknown,
  bookId: unknown,
): BookCoverPathClass {
  if (isOwnCanonicalBookCoverPath(path, authorId, bookId)) {
    return "canonical";
  }
  if (typeof path !== "string" || !idsAreCanonical(authorId, bookId)) {
    return "unsafe";
  }
  const stem = `${authorId}/${bookId as string}-cover.`;
  const isLegacy = path.startsWith(stem) && LEGACY_BOOK_COVER_EXTENSION.test(path.slice(stem.length));
  return isLegacy ? "legacy" : "unsafe";
}

// True only when `path` is a cover key this author may remove for this
// exact book: its canonical key or its documented legacy key.
export function isOwnRemovableBookCoverPath(
  path: unknown,
  authorId: unknown,
  bookId: unknown,
): path is string {
  return classifyBookCoverPath(path, authorId, bookId) !== "unsafe";
}

// BOOK-STORAGE-MUTATION-AUTH-1: the temporary upload keys the browser
// stages in the private manuscripts bucket before createBook/updateBook
// promote them (cover-field.tsx, manuscript-field.tsx and
// docx-actions.ts build them from the signed-in author's id and a fresh
// crypto.randomUUID()):
//
//   <author id>/tmp/epub/<uuid>.epub
//   <author id>/tmp/cover/<uuid>.<jpg|png>
//
// The server downloads and later removes such a key with the author's
// own session, so it is accepted only as that exact shape under the
// caller's own id -- never on its prefix alone -- which refuses
// traversal, encoding, backslashes, extra depth, other authors and every
// other hostile value before any Storage call sees it.
const UUID_BODY = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const TEMPORARY_MANUSCRIPT_FILE = new RegExp(`^${UUID_BODY}\\.epub$`);
const TEMPORARY_COVER_FILE = new RegExp(`^${UUID_BODY}\\.(?:jpg|png)$`);

function isOwnTemporaryUploadPath(
  path: unknown,
  authorId: unknown,
  folder: "epub" | "cover",
  file: RegExp,
): path is string {
  if (typeof path !== "string" || typeof authorId !== "string" || !UUID_PATTERN.test(authorId)) {
    return false;
  }
  const prefix = `${authorId}/tmp/${folder}/`;
  return path.startsWith(prefix) && file.test(path.slice(prefix.length));
}

export function isOwnTemporaryManuscriptUploadPath(path: unknown, authorId: unknown): path is string {
  return isOwnTemporaryUploadPath(path, authorId, "epub", TEMPORARY_MANUSCRIPT_FILE);
}

export function isOwnTemporaryCoverUploadPath(path: unknown, authorId: unknown): path is string {
  return isOwnTemporaryUploadPath(path, authorId, "cover", TEMPORARY_COVER_FILE);
}

// BOOK-STORAGE-MUTATION-AUTH-1: collects already-proven removal
// candidates into one de-duplicated key list per bucket, in first-seen
// order, so no object is ever named twice in a removal and each bucket
// gets at most one Storage call. It proves nothing itself: every
// candidate must already have passed one of the classifiers above.
export type BookStorageBucket = typeof BOOK_COVERS_BUCKET | typeof BOOK_MANUSCRIPTS_BUCKET;
export type BookStorageRemoval = { bucket: BookStorageBucket; path: string };

export function groupBookStorageRemovals(
  removals: readonly BookStorageRemoval[],
): [BookStorageBucket, string[]][] {
  const grouped = new Map<BookStorageBucket, Set<string>>();
  for (const { bucket, path } of removals) {
    const paths = grouped.get(bucket) ?? new Set<string>();
    paths.add(path);
    grouped.set(bucket, paths);
  }
  return [...grouped].map(([bucket, paths]) => [bucket, [...paths]]);
}
