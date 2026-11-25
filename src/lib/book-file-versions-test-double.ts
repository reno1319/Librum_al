// TEST-ONLY. Never imported by application code.
//
// FV1: the suites written before file versions use session/catalog
// doubles that know nothing about book_file_versions. They mock
// "@/lib/book-file-versions" with this double: the pure formatters stay
// real; the reads are replaced by a mutable state each suite can set.
// The default is the state of every book those suites were written
// for: no file was ever replaced, so no once-live file is kept.
//
// The rules themselves are pinned in src/lib/book-file-versions.test.ts,
// src/lib/book-reviews.test.ts and the SQL suite (116).

export type BookFileVersionsDoubleState = {
  pathsOk: boolean;
  /** Once-live keys, by book id. */
  paths: Record<string, string[]>;
  /** What the two lists read: null = unreadable. */
  earlier: { id: string; liveFrom: string; replacedAt: string; sizeBytes: number | null }[] | null;
  calls: { fn: string; bookIds: string[] }[];
};

export function defaultBookFileVersionsDoubleState(): BookFileVersionsDoubleState {
  return { pathsOk: true, paths: {}, earlier: [], calls: [] };
}

export const bookFileVersionsDoubleState: BookFileVersionsDoubleState = defaultBookFileVersionsDoubleState();

export function resetBookFileVersionsDouble(): void {
  Object.assign(bookFileVersionsDoubleState, defaultBookFileVersionsDoubleState());
}

/** Spread over the real module inside vi.mock("@/lib/book-file-versions"). */
export function bookFileVersionsDouble<T extends object>(actual: T) {
  const s = bookFileVersionsDoubleState;
  return {
    ...actual,
    readFileVersionPaths: async (_client: unknown, bookIds: readonly string[]) => {
      s.calls.push({ fn: "readFileVersionPaths", bookIds: [...bookIds] });
      if (!s.pathsOk) return { ok: false as const };
      const byBook = new Map<string, string[]>();
      for (const id of bookIds) if (s.paths[id]) byBook.set(id, [...s.paths[id]]);
      return { ok: true as const, byBook };
    },
    readEarlierBookFiles: async (_client: unknown, book: { id: string }) => {
      s.calls.push({ fn: "readEarlierBookFiles", bookIds: [book.id] });
      return s.earlier === null ? null : s.earlier.map((file) => ({ ...file }));
    },
  };
}
