import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { BOOK_MANUSCRIPTS_BUCKET, isOwnBookManuscriptPath } from "@/lib/book-storage-path";
import { formatTimestampAsDate } from "@/lib/book-detail-dates";

// FV1 (Renato 24-25 Nov 2026, fv1-fv5 a): every file that was once a
// book's live file is kept, with its dates, in public.book_file_versions
// (migration 20261125120000; written only by its trigger, read only with
// the service key). Buyers always get the current file (fv1 a); the
// author's Content tab and the staff book page list the earlier ones
// with a download (fv2 a); the files go with an unsold book (fv5 a).
//
// Every read here fails closed: retention and deletion that can't read
// the list remove nothing, and a page that can't read it shows nothing.

type ServiceClient = ReturnType<typeof createAdminClient>;

export const BOOK_FILE_VERSIONS_TABLE = "book_file_versions";

/** Each book's once-live file keys (current one included). Fails closed. */
export type FileVersionPathsRead = { ok: true; byBook: Map<string, string[]> } | { ok: false };

export async function readFileVersionPaths(
  service: ServiceClient,
  bookIds: readonly string[],
): Promise<FileVersionPathsRead> {
  const byBook = new Map<string, string[]>();
  const ids = Array.from(new Set(bookIds));
  if (ids.length === 0) return { ok: true, byBook };
  const { data, error } = await service
    .from(BOOK_FILE_VERSIONS_TABLE)
    .select("book_id, file_path")
    .in("book_id", ids)
    .returns<{ book_id: string; file_path: string }[]>();
  if (error || !Array.isArray(data)) {
    console.error("readFileVersionPaths: read failed", { bookCount: ids.length, code: error?.code ?? null });
    return { ok: false };
  }
  for (const row of data) {
    const list = byBook.get(row.book_id) ?? [];
    list.push(row.file_path);
    byBook.set(row.book_id, list);
  }
  return { ok: true, byBook };
}

/** One earlier file, as the two lists show it. */
export type EarlierBookFile = {
  id: string;
  liveFrom: string;
  replacedAt: string;
  sizeBytes: number | null;
};

type VersionRow = { id: string; file_path: string; live_from: string; replaced_at: string | null };

/**
 * The book's earlier files (replaced ones only), newest first, each
 * with its size read from Storage (null when that read fails). Only the
 * book's own keys are listed. `null` when the list can't be read.
 */
export async function readEarlierBookFiles(
  service: ServiceClient,
  book: { id: string; authorId: string },
): Promise<EarlierBookFile[] | null> {
  const { data, error } = await service
    .from(BOOK_FILE_VERSIONS_TABLE)
    .select("id, file_path, live_from, replaced_at")
    .eq("book_id", book.id)
    .not("replaced_at", "is", null)
    .order("replaced_at", { ascending: false })
    .returns<VersionRow[]>();
  if (error || !Array.isArray(data)) {
    console.error("readEarlierBookFiles: read failed", { bookId: book.id, code: error?.code ?? null });
    return null;
  }
  const rows = data.filter(
    (row): row is VersionRow & { replaced_at: string } =>
      row.replaced_at !== null && isOwnBookManuscriptPath(row.file_path, book.authorId, book.id),
  );
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      liveFrom: row.live_from,
      replacedAt: row.replaced_at,
      sizeBytes: await readStoredSize(service, row.file_path),
    })),
  );
}

async function readStoredSize(service: ServiceClient, path: string): Promise<number | null> {
  try {
    const { data, error } = await service.storage.from(BOOK_MANUSCRIPTS_BUCKET).info(path);
    const size = (data as { size?: unknown } | null)?.size;
    return !error && typeof size === "number" && Number.isFinite(size) && size >= 0 ? size : null;
  } catch {
    return null;
  }
}

/**
 * The key of one earlier file of this book, for its download: the row
 * must be this book's, already replaced, and the book's own key.
 * "missing" for anything else; "error" when it can't be read.
 */
export async function readEarlierBookFilePath(
  service: ServiceClient,
  book: { id: string; authorId: string },
  versionId: string,
): Promise<{ kind: "ok"; filePath: string; liveFrom: string } | { kind: "missing" } | { kind: "error" }> {
  const { data, error } = await service
    .from(BOOK_FILE_VERSIONS_TABLE)
    .select("id, file_path, live_from, replaced_at")
    .eq("id", versionId)
    .eq("book_id", book.id)
    .maybeSingle<VersionRow>();
  if (error) return { kind: "error" };
  if (!data || data.replaced_at === null || !isOwnBookManuscriptPath(data.file_path, book.authorId, book.id)) {
    return { kind: "missing" };
  }
  return { kind: "ok", filePath: data.file_path, liveFrom: data.live_from };
}

/** "1,3 MB" (Albanian) or "1.3 MB" (staff, English); KB under 1 MB. */
export function formatFileSize(bytes: number, language: "sq" | "en"): string {
  const decimal = (value: number) => {
    const text = value.toFixed(1).replace(/\.0$/, "");
    return language === "sq" ? text.replace(".", ",") : text;
  };
  if (bytes < 1024 * 1024) return `${decimal(Math.max(bytes / 1024, 1))} KB`;
  return `${decimal(bytes / (1024 * 1024))} MB`;
}

const EN_DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Europe/Tirane",
});

/** One row's text, e.g. "skedar EPUB · në shitje 5 tetor 2026 – 2 nëntor 2026 · 1,2 MB". */
export function earlierFileLine(file: EarlierBookFile, language: "sq" | "en"): string {
  const date = (iso: string) => (language === "sq" ? formatTimestampAsDate(iso) : EN_DATE.format(new Date(iso)));
  const parts =
    language === "sq"
      ? ["skedar EPUB", `në shitje ${date(file.liveFrom)} – ${date(file.replacedAt)}`]
      : ["EPUB", `live ${date(file.liveFrom)} – ${date(file.replacedAt)}`];
  if (file.sizeBytes !== null) parts.push(formatFileSize(file.sizeBytes, language));
  return parts.join(" · ");
}
