import "server-only";
import { embedCoverInLibrumEpub, isLibrumMadeEpub } from "@/lib/epub-cover";
import { validateEpubStructure } from "@/lib/epub-validation";
import { BOOK_MANUSCRIPTS_BUCKET } from "@/lib/book-storage-path";

// W7: the save-step wrapper around embedCoverInLibrumEpub() that
// createBook()/updateBook() call. It never fails a save (Renato 2a): a
// Librum-made ebook whose cover could not be put in is stored exactly as
// it was, the reason is logged, and the caller adds one line under the
// author's success message (Q1 b-lite, src/lib/ebook-cover-notice.ts).
// An ebook the author uploaded directly returns "not_librum_made" at
// once, before any cover or name is even looked up.
//
// Inputs are lazy so a direct EPUB upload costs no image resize, no
// Storage read and no pen name read.
export type EbookCoverSyncInput = {
  getCoverJpeg: () => Promise<Buffer | null>;
  title: string | null;
  getAuthorName: () => Promise<string | null>;
  maxBytes: number;
  caller: string;
  bookId: string;
};

export type EbookCoverSyncResult =
  | { kind: "not_librum_made" }
  | { kind: "embedded"; bytes: Buffer }
  // Librum-made, but the cover could not be put in: store as it was.
  | { kind: "skipped" };

// W7 r2 (audit R2): Storage object metadata set on every stored ebook
// Librum made, so a later cover-only change can ask Storage (info()) and
// download the ebook only when Librum made it. Final manuscript keys are
// written only by the server's catalog writer, so an author cannot set it.
// r3 (audit B1): the key has no "_" or "-", because storage-js info()
// camelizes every nested key (recursiveToCamel), so "librum_made" would
// come back as "librumMade". "librum" survives unchanged.
export const LIBRUM_MADE_EBOOK_METADATA = { librum: "made" } as const;

// The marker as Storage's info() returns it (the upload's custom metadata,
// under `metadata` and/or `userMetadata` once camelized). Exactly
// librum: "made" counts; nothing else does.
export function hasLibrumMadeMarker(info: unknown): boolean {
  if (!info || typeof info !== "object") return false;
  const record = info as { metadata?: unknown; userMetadata?: unknown };
  for (const candidate of [record.metadata, record.userMetadata]) {
    if (candidate && typeof candidate === "object" && (candidate as { librum?: unknown }).librum === "made") {
      return true;
    }
  }
  return false;
}

// Whether Storage marks this stored ebook (in the manuscripts bucket) as
// Librum-made, WITHOUT downloading it. "unknown" when info() fails: the
// caller then skips the swap and logs it. Takes the client's `storage`
// so the real storage-js client can be tested end to end (audit B1).
type StorageInfoClient = {
  from(bucket: string): { info(path: string): Promise<{ data: unknown; error: unknown }> };
};

export async function readLibrumMadeMarker(
  storage: StorageInfoClient,
  path: string,
): Promise<"yes" | "no" | "unknown"> {
  try {
    const { data, error } = await storage.from(BOOK_MANUSCRIPTS_BUCKET).info(path);
    if (error || !data) return "unknown";
    return hasLibrumMadeMarker(data) ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

export async function syncCoverIntoLibrumEbook(
  epubBytes: Buffer,
  input: EbookCoverSyncInput,
): Promise<EbookCoverSyncResult> {
  if (!(await isLibrumMadeEpub(epubBytes))) return { kind: "not_librum_made" };

  const skip = (reason: string): EbookCoverSyncResult => {
    console.error(`${input.caller}: cover not put inside the Librum-made ebook; ebook kept as it was`, {
      bookId: input.bookId,
      reason,
    });
    return { kind: "skipped" };
  };

  let coverJpeg: Buffer | null = null;
  try {
    coverJpeg = await input.getCoverJpeg();
  } catch {
    coverJpeg = null;
  }
  if (!coverJpeg) return skip("cover_unavailable");

  let authorName: string | null = null;
  try {
    authorName = await input.getAuthorName();
  } catch {
    authorName = null;
  }

  const embedded = await embedCoverInLibrumEpub(epubBytes, { coverJpeg, title: input.title, authorName });
  if (!embedded.ok) return skip(embedded.reason);
  // The manuscripts bucket and every reader-side check keep the same
  // 50 MB ceiling; a cover must never push a stored ebook past it.
  if (embedded.bytes.length > input.maxBytes) return skip("too_large");
  // The same validator every stored ebook has passed.
  const validation = await validateEpubStructure(embedded.bytes);
  if (!validation.valid) return skip(`invalid_${validation.reason}`);
  return { kind: "embedded", bytes: embedded.bytes };
}
