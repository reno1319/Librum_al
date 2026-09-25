import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import {
  BOOK_FIXTURE_AUTHOR_ID as USER_ID,
  BOOK_FIXTURE_BOOK_ID as BOOK_ID,
  BOOK_FIXTURE_OTHER_AUTHOR_ID as OTHER_AUTHOR,
  BOOK_FIXTURE_OTHER_BOOK_ID as OTHER_BOOK,
  UNSAFE_COVER_PATHS,
  UNSAFE_MANUSCRIPT_PATHS,
} from "@/lib/book-storage-path-test-fixtures";
import { canonicalBookCoverPath, canonicalBookManuscriptPath } from "@/lib/book-storage-path";

// BOOK-STORAGE-MUTATION-AUTH-1 (F5): the real createBook/updateBook/
// deleteBook actions against one recording Supabase double. Every
// Storage call (upload, download, remove, move, copy, signed URL) and
// every database write is recorded in order, so each test can prove
// which keys reach Storage, when, and what each write carried.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/recovery-guard", () => ({ redirectIfRecoverySessionActive: vi.fn() }));

type Filter = { kind: string; column: string; value: unknown };
type DbWrite = { table: string; op: string; payload: unknown; filters: Filter[] };
type StorageCall = { op: string; bucket: string; paths: unknown[] };
type Result = { data: unknown; error: unknown };

const events: string[] = [];
let storageCalls: StorageCall[] = [];
let dbWrites: DbWrite[] = [];
let signedInUserId: string | null = USER_ID;
let bookReadResult: Result;
let updateResult: Result | null;
let deleteResult: Result | null;
let removeError: unknown = null;
let storedObjects: Record<string, Buffer> = {};

function query(table: string) {
  const filters: Filter[] = [];
  let op = "select";
  let payload: unknown = undefined;
  let returning = false;
  const resolve = (): Result => {
    if (op === "select") {
      if (table === "books") return bookReadResult;
      if (table === "bundle_books") return { data: [], error: null };
      if (table === "purchases") return { data: null, error: null, count: 0 } as Result;
      throw new Error(`unexpected read of ${table}`);
    }
    const write = { table, op, payload, filters: [...filters] };
    dbWrites.push(write);
    events.push(`db:${op}:${table}`);
    if (op === "update") {
      const rows = updateResult ?? { data: [{ id: BOOK_ID }], error: null };
      return returning ? rows : { data: null, error: rows.error };
    }
    if (op === "delete") {
      const rows = deleteResult ?? { data: [{ id: BOOK_ID }], error: null };
      return returning ? rows : { data: null, error: rows.error };
    }
    if (op === "insert") {
      return { data: [{ id: (payload as { id: string }).id }], error: null };
    }
    throw new Error(`unexpected op ${op}`);
  };
  const chain: Record<string, unknown> = {
    select: () => {
      if (op !== "select") returning = true;
      return chain;
    },
    update: (p: unknown) => {
      op = "update";
      payload = p;
      return chain;
    },
    delete: () => {
      op = "delete";
      return chain;
    },
    insert: (p: unknown) => {
      op = "insert";
      payload = p;
      return chain;
    },
    eq: (column: string, value: unknown) => {
      filters.push({ kind: "eq", column, value });
      return chain;
    },
    is: (column: string, value: unknown) => {
      filters.push({ kind: "is", column, value });
      return chain;
    },
    single: () => Promise.resolve(resolve()),
    maybeSingle: () => Promise.resolve(resolve()),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(resolve)
        .then(onFulfilled, onRejected),
  };
  return chain;
}

function storageBucket(bucket: string) {
  const record = (op: string, paths: unknown[]) => {
    storageCalls.push({ op, bucket, paths });
    events.push(`storage:${op}:${bucket}`);
  };
  return {
    upload: async (path: unknown) => {
      record("upload", [path]);
      return { error: null };
    },
    download: async (path: unknown) => {
      record("download", [path]);
      const bytes = storedObjects[`${bucket}:${String(path)}`];
      return bytes
        ? { data: { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, error: null }
        : { data: null, error: { message: "not found" } };
    },
    remove: async (paths: unknown[]) => {
      record("remove", paths);
      return removeError ? { data: null, error: removeError } : { data: [], error: null };
    },
    move: async (from: unknown, to: unknown) => {
      record("move", [from, to]);
      return { error: null };
    },
    copy: async (from: unknown, to: unknown) => {
      record("copy", [from, to]);
      return { error: null };
    },
    createSignedUrl: async (path: unknown) => {
      record("createSignedUrl", [path]);
      return { data: null, error: null };
    },
  };
}

const sessionClient = {
  auth: {
    getUser: async () => ({ data: { user: signedInUserId ? { id: signedInUserId } : null } }),
  },
  from: (table: string) => query(table),
  storage: { from: (bucket: string) => storageBucket(bucket) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessionClient }));
vi.mock("@/lib/catalog-write-client", async () => {
  const { catalogWriterReplayingOnto } = await import("@/lib/catalog-write-test-double");
  return { createCatalogWriteClient: () => catalogWriterReplayingOnto(() => sessionClient) };
});

const { createBook, updateBook, deleteBook } = await import("./actions");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
const TEMP_EPUB = `${USER_ID}/tmp/epub/e5f6a7b8-7777-4777-8777-abcdef777777.epub`;
const TEMP_COVER = `${USER_ID}/tmp/cover/f6a7b8c9-8888-4888-8888-abcdef888888.png`;

const OWN_PNG = canonicalBookCoverPath(USER_ID, BOOK_ID, "png");
const OWN_JPG = canonicalBookCoverPath(USER_ID, BOOK_ID, "jpg");
const OWN_EPUB = canonicalBookManuscriptPath(USER_ID, BOOK_ID);
const LEGACY_JPEG = `${USER_ID}/${BOOK_ID}-cover.jpeg`;

async function validEpub(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
  );
  zip.file(
    "content.opf",
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata><manifest></manifest><spine></spine></package>`,
  );
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK_ID,
    author_id: USER_ID,
    cover_path: OWN_PNG,
    file_path: OWN_EPUB,
    language: "sq",
    status: "draft",
    price_all: 0,
    ...overrides,
  };
}

function editForm(): FormData {
  const f = new FormData();
  f.set("title", "Title");
  f.set("description", "Description");
  f.set("keywords", "");
  f.set("isbn", "");
  f.set("genre", "Fiction");
  f.set("price", "0");
  return f;
}

function withCover(f: FormData, bytes: Buffer = PNG): FormData {
  f.set("cover", new File([new Uint8Array(bytes)], "anything.gif"));
  return f;
}

async function withManuscript(f: FormData): Promise<FormData> {
  f.set("manuscript", new File([new Uint8Array(await validEpub())], "book.epub"));
  return f;
}

async function run(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (e) {
    if (e instanceof RedirectSignal) return e.target;
    throw e;
  }
  return "(no redirect)";
}

const bookUpdates = () => dbWrites.filter((w) => w.table === "books" && w.op === "update");
const bookDeletes = () => dbWrites.filter((w) => w.table === "books" && w.op === "delete");
const removals = () => storageCalls.filter((c) => c.op === "remove");
const everyStorageKey = () => storageCalls.flatMap((c) => c.paths);

let consoleOutput: unknown[][] = [];

beforeEach(() => {
  events.length = 0;
  storageCalls = [];
  dbWrites = [];
  signedInUserId = USER_ID;
  bookReadResult = { data: row(), error: null };
  updateResult = null;
  deleteResult = null;
  removeError = null;
  storedObjects = {};
  consoleOutput = [];
  for (const level of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleOutput.push(args);
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

function loggedText(): string {
  return consoleOutput
    .map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a, (_k, v) => (v instanceof Error ? v.message : v)))).join(" "))
    .join("\n");
}

// ============================================================
describe("updateBook without an upload", () => {
  it("omits both path keys, leaves the stored values untouched, and makes no Storage call", async () => {
    expect(await run(updateBook(BOOK_ID, editForm()))).toBe("/dashboard?success=Book+updated");
    const [update] = bookUpdates();
    expect(update.payload).not.toHaveProperty("cover_path");
    expect(update.payload).not.toHaveProperty("file_path");
    expect(storageCalls).toEqual([]);
  });

  it.each([
    ["the Production legacy .jpeg cover", { cover_path: LEGACY_JPEG }],
    ["an unsafe foreign cover", { cover_path: `${OTHER_AUTHOR}/${OTHER_BOOK}-cover.png` }],
    ["an unsafe manuscript", { file_path: `${USER_ID}/../${OTHER_AUTHOR}/${BOOK_ID}.epub` }],
    ["null paths", { cover_path: null, file_path: null }],
  ])("keeps working for %s without touching it", async (_label, overrides) => {
    bookReadResult = { data: row(overrides), error: null };
    expect(await run(updateBook(BOOK_ID, editForm()))).toBe("/dashboard?success=Book+updated");
    expect(bookUpdates()[0].payload).not.toHaveProperty("cover_path");
    expect(bookUpdates()[0].payload).not.toHaveProperty("file_path");
    expect(storageCalls).toEqual([]);
  });

  it("never adopts a client-supplied path or id", async () => {
    const f = editForm();
    f.set("cover_path", `${OTHER_AUTHOR}/x.png`);
    f.set("file_path", `${OTHER_AUTHOR}/x.epub`);
    f.set("coverPath", `${OTHER_AUTHOR}/x.png`);
    f.set("id", OTHER_BOOK);
    f.set("author_id", OTHER_AUTHOR);
    expect(await run(updateBook(BOOK_ID, f))).toBe("/dashboard?success=Book+updated");
    expect(JSON.stringify(bookUpdates()[0].payload)).not.toContain(OTHER_AUTHOR);
    expect(JSON.stringify(bookUpdates()[0].payload)).not.toContain(OTHER_BOOK);
  });
});

// ============================================================
describe("updateBook with a replacement", () => {
  it("manuscript only: writes only file_path, never re-persists or removes the cover", async () => {
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: null };
    expect(await run(updateBook(BOOK_ID, await withManuscript(editForm())))).toBe(
      "/dashboard?success=Book+updated",
    );
    const payload = bookUpdates()[0].payload as Record<string, unknown>;
    expect(payload.file_path).toBe(OWN_EPUB);
    expect(payload).not.toHaveProperty("cover_path");
    expect(storageCalls).toEqual([{ op: "upload", bucket: "manuscripts", paths: [OWN_EPUB] }]);
  });

  it("cover only: writes only cover_path, never re-persists or removes the manuscript", async () => {
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe("/dashboard?success=Book+updated");
    const payload = bookUpdates()[0].payload as Record<string, unknown>;
    expect(payload.cover_path).toBe(OWN_JPG);
    expect(payload).not.toHaveProperty("file_path");
    expect(storageCalls).toEqual([
      { op: "upload", bucket: "covers", paths: [OWN_JPG] },
      { op: "remove", bucket: "covers", paths: [OWN_PNG] },
    ]);
  });

  it("the key is derived from the session user, the row id and the verified bytes -- not the file name", async () => {
    await run(updateBook(BOOK_ID, withCover(editForm(), PNG)));
    expect(storageCalls[0]).toEqual({ op: "upload", bucket: "covers", paths: [OWN_PNG] });
  });

  it("same key replaced in place: nothing is removed", async () => {
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), PNG)))).toBe("/dashboard?success=Book+updated");
    expect(removals()).toEqual([]);
  });

  it("the exact own-book legacy .jpeg cover is removed only after the write, and never re-created", async () => {
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: null };
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe("/dashboard?success=Book+updated");
    expect(events).toEqual(["storage:upload:covers", "db:update:books", "storage:remove:covers"]);
    expect(removals()).toEqual([{ op: "remove", bucket: "covers", paths: [LEGACY_JPEG] }]);
    expect(everyStorageKey().filter((k) => String(k).endsWith(".jpeg"))).toEqual([LEGACY_JPEG]);
    expect((bookUpdates()[0].payload as Record<string, unknown>).cover_path).toBe(OWN_JPG);
  });

  it("filters the write by id, author_id and the cover_path it read (compare-and-set)", async () => {
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: null };
    await run(updateBook(BOOK_ID, withCover(editForm())));
    const { filters } = bookUpdates()[0];
    expect(filters).toContainEqual({ kind: "eq", column: "id", value: BOOK_ID });
    expect(filters).toContainEqual({ kind: "eq", column: "author_id", value: USER_ID });
    expect(filters).toContainEqual({ kind: "eq", column: "cover_path", value: LEGACY_JPEG });
  });

  it("a null stored cover compares with IS NULL", async () => {
    bookReadResult = { data: row({ cover_path: null }), error: null };
    expect(await run(updateBook(BOOK_ID, withCover(editForm())))).toBe("/dashboard?success=Book+updated");
    expect(bookUpdates()[0].filters).toContainEqual({ kind: "is", column: "cover_path", value: null });
    expect(removals()).toEqual([]);
  });

  it("a write without a cover replacement keeps the id and author_id filters and no cover filter", async () => {
    await run(updateBook(BOOK_ID, editForm()));
    const { filters } = bookUpdates()[0];
    expect(filters).toContainEqual({ kind: "eq", column: "id", value: BOOK_ID });
    expect(filters).toContainEqual({ kind: "eq", column: "author_id", value: USER_ID });
    expect(filters.some((f) => f.column === "cover_path")).toBe(false);
  });

  it("temporary uploads are removed after the write, de-duplicated, in one call per bucket", async () => {
    storedObjects[`manuscripts:${TEMP_EPUB}`] = await validEpub();
    storedObjects[`manuscripts:${TEMP_COVER}`] = JPG;
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: null };
    const f = editForm();
    f.set("manuscriptStoragePath", TEMP_EPUB);
    f.set("coverStoragePath", TEMP_COVER);
    expect(await run(updateBook(BOOK_ID, f))).toBe("/dashboard?success=Book+updated");
    expect(removals()).toEqual([
      { op: "remove", bucket: "covers", paths: [LEGACY_JPEG] },
      { op: "remove", bucket: "manuscripts", paths: [TEMP_EPUB, TEMP_COVER] },
    ]);
    for (const call of removals()) {
      expect(new Set(call.paths).size).toBe(call.paths.length);
    }
    expect(events.indexOf("db:update:books")).toBeLessThan(events.indexOf("storage:remove:covers"));
  });
});

// ============================================================
describe("updateBook never hands an unsafe stored path to Storage", () => {
  const coverCases = UNSAFE_COVER_PATHS.filter(([, v]) => typeof v === "string" && v !== LEGACY_JPEG) as [string, string][];
  const manuscriptCases = UNSAFE_MANUSCRIPT_PATHS.filter(([, v]) => typeof v === "string") as [string, string][];

  it.each(coverCases)("stored cover %s: replacement succeeds, the old value is left untouched", async (_label, value) => {
    bookReadResult = { data: row({ cover_path: value }), error: null };
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe("/dashboard?success=Book+updated");
    expect(storageCalls).toEqual([{ op: "upload", bucket: "covers", paths: [OWN_JPG] }]);
    expect((bookUpdates()[0].payload as Record<string, unknown>).cover_path).toBe(OWN_JPG);
    if (value.trim().length > 8) expect(loggedText()).not.toContain(value);
  });

  it.each(manuscriptCases)("stored manuscript %s: replacement succeeds, the old value is left untouched", async (_label, value) => {
    bookReadResult = { data: row({ file_path: value }), error: null };
    expect(await run(updateBook(BOOK_ID, await withManuscript(editForm())))).toBe(
      "/dashboard?success=Book+updated",
    );
    expect(storageCalls).toEqual([{ op: "upload", bucket: "manuscripts", paths: [OWN_EPUB] }]);
    if (value.trim().length > 8) expect(loggedText()).not.toContain(value);
  });

  it("another author's canonical-looking cover is never removed", async () => {
    bookReadResult = { data: row({ cover_path: `${OTHER_AUTHOR}/${BOOK_ID}-cover.png` }), error: null };
    await run(updateBook(BOOK_ID, withCover(editForm(), JPG)));
    expect(removals()).toEqual([]);
  });

  it("the same author's other book's cover (canonical or legacy) is never removed", async () => {
    for (const other of [`${USER_ID}/${OTHER_BOOK}-cover.png`, `${USER_ID}/${OTHER_BOOK}-cover.jpeg`]) {
      storageCalls = [];
      bookReadResult = { data: row({ cover_path: other }), error: null };
      await run(updateBook(BOOK_ID, withCover(editForm(), JPG)));
      expect(removals()).toEqual([]);
    }
  });
});

// ============================================================
describe("updateBook fails closed on identity, read and write failures", () => {
  it.each([
    ["a read error", { data: null, error: { message: "boom" } }],
    ["no row", { data: null, error: null }],
    ["another author's row", { data: row({ author_id: OTHER_AUTHOR }), error: null }],
    ["a different row id", { data: row({ id: OTHER_BOOK }), error: null }],
  ])("%s: redirects away before any upload or write", async (_label, result) => {
    bookReadResult = result as Result;
    expect(await run(updateBook(BOOK_ID, withCover(editForm())))).toBe("/dashboard");
    expect(storageCalls).toEqual([]);
    expect(dbWrites).toEqual([]);
  });

  it("an upper-case spelling of the book id is refused before any upload", async () => {
    expect(await run(updateBook(BOOK_ID.toUpperCase(), withCover(editForm())))).toBe("/dashboard");
    expect(storageCalls).toEqual([]);
  });

  it.each([
    ["zero rows", { data: [], error: null }],
    ["two rows", { data: [{ id: BOOK_ID }, { id: BOOK_ID }], error: null }],
    ["null data", { data: null, error: null }],
    ["a mismatched row", { data: [{ id: OTHER_BOOK }], error: null }],
    ["a row without an id", { data: [{}], error: null }],
  ])("%s returned: no success and no removal", async (_label, result) => {
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: null };
    updateResult = result as Result;
    const target = await run(updateBook(BOOK_ID, withCover(editForm(), JPG)));
    expect(target).toMatch(new RegExp(`^/dashboard/books/${BOOK_ID}/edit\\?error=`));
    expect(removals()).toEqual([]);
  });

  it("a write error: no success and no removal", async () => {
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: null };
    updateResult = { data: null, error: { message: "db exploded" } };
    const target = await run(updateBook(BOOK_ID, withCover(editForm(), JPG)));
    expect(target).toMatch(new RegExp(`^/dashboard/books/${BOOK_ID}/edit\\?error=`));
    expect(removals()).toEqual([]);
  });

  it("a concurrent cover change (compare-and-set matches no row): the old cover is not removed", async () => {
    bookReadResult = { data: row({ cover_path: OWN_JPG }), error: null };
    updateResult = { data: [], error: null };
    await run(updateBook(BOOK_ID, withCover(editForm(), PNG)));
    expect(removals()).toEqual([]);
  });
});

// ============================================================
describe("temporary upload references", () => {
  const hostile: [string, string][] = [
    ["another author", `${OTHER_AUTHOR}/tmp/epub/e5f6a7b8-7777-4777-8777-abcdef777777.epub`],
    ["traversal", `${USER_ID}/tmp/epub/../../${OTHER_AUTHOR}/${OTHER_BOOK}.epub`],
    ["leading slash", `/${TEMP_EPUB}`],
    ["backslash", TEMP_EPUB.replace(/\//g, "\\")],
    ["percent-encoded", `${USER_ID}/tmp/epub%2Fe5f6a7b8-7777-4777-8777-abcdef777777.epub`],
    ["URL", `https://x.supabase.co/storage/v1/object/manuscripts/${TEMP_EPUB}`],
    ["bucket-prefixed", `manuscripts/${TEMP_EPUB}`],
    ["permanent key of another book", `${USER_ID}/${OTHER_BOOK}.epub`],
    ["NUL", `${TEMP_EPUB}\u0000`],
  ];

  it.each(hostile)("a manuscript reference with %s is refused before any Storage call", async (_label, value) => {
    const f = editForm();
    f.set("manuscriptStoragePath", value);
    expect(await run(updateBook(BOOK_ID, f))).toMatch(/error=That\+manuscript\+reference/);
    expect(storageCalls).toEqual([]);
    expect(dbWrites).toEqual([]);
  });

  it.each(hostile.map(([l, v]) => [l, v.replace("/tmp/epub", "/tmp/cover").replace(/\.epub/, ".png")]))(
    "a cover reference with %s is refused before any Storage call",
    async (_label, value) => {
      const f = editForm();
      f.set("coverStoragePath", value);
      expect(await run(updateBook(BOOK_ID, f))).toMatch(/error=That\+cover\+reference/);
      expect(storageCalls).toEqual([]);
    },
  );
});

// ============================================================
describe("createBook", () => {
  async function createForm(): Promise<FormData> {
    const f = await withManuscript(withCover(editForm(), PNG));
    f.set("price", "0");
    return f;
  }

  it("writes the keys built by the shared constructors for the session user and the new id", async () => {
    expect(await run(createBook(await createForm()))).toBe("/dashboard");
    const insert = dbWrites.find((w) => w.op === "insert")!;
    const id = (insert.payload as { id: string }).id;
    expect(insert.payload).toMatchObject({
      author_id: USER_ID,
      cover_path: canonicalBookCoverPath(USER_ID, id, "png"),
      file_path: canonicalBookManuscriptPath(USER_ID, id),
    });
    expect(everyStorageKey()).toEqual([
      canonicalBookCoverPath(USER_ID, id, "png"),
      canonicalBookManuscriptPath(USER_ID, id),
    ]);
  });

  it("temporary uploads are removed only after the insert, in one de-duplicated call", async () => {
    storedObjects[`manuscripts:${TEMP_EPUB}`] = await validEpub();
    storedObjects[`manuscripts:${TEMP_COVER}`] = PNG;
    const f = editForm();
    f.set("manuscriptStoragePath", TEMP_EPUB);
    f.set("coverStoragePath", TEMP_COVER);
    expect(await run(createBook(f))).toBe("/dashboard");
    expect(removals()).toEqual([{ op: "remove", bucket: "manuscripts", paths: [TEMP_EPUB, TEMP_COVER] }]);
    expect(events.indexOf("db:insert:books")).toBeLessThan(events.indexOf("storage:remove:manuscripts"));
  });

  it("a non-UUID session identity cannot produce a key", async () => {
    signedInUserId = "author-1";
    await expect(createBook(await createForm())).rejects.toThrow(/lowercase UUID/);
    expect(storageCalls).toEqual([]);
    expect(dbWrites).toEqual([]);
  });
});

// ============================================================
describe("deleteBook", () => {
  it("removes exactly this book's own canonical keys, after the delete, filtered by id and author_id", async () => {
    await run(deleteBook(BOOK_ID));
    const [del] = bookDeletes();
    expect(del.filters).toContainEqual({ kind: "eq", column: "id", value: BOOK_ID });
    expect(del.filters).toContainEqual({ kind: "eq", column: "author_id", value: USER_ID });
    expect(removals()).toEqual([
      { op: "remove", bucket: "covers", paths: [OWN_PNG] },
      { op: "remove", bucket: "manuscripts", paths: [OWN_EPUB] },
    ]);
    expect(events.indexOf("db:delete:books")).toBeLessThan(events.indexOf("storage:remove:covers"));
  });

  it("removes the exact own-book legacy .jpeg cover (the lowercase spelling of the Stage A class)", async () => {
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: null };
    await run(deleteBook(BOOK_ID));
    expect(removals()).toEqual([
      { op: "remove", bucket: "covers", paths: [LEGACY_JPEG] },
      { op: "remove", bucket: "manuscripts", paths: [OWN_EPUB] },
    ]);
  });

  const coverCases = UNSAFE_COVER_PATHS.filter(([, v]) => typeof v === "string" && v !== LEGACY_JPEG) as [string, string][];
  const manuscriptCases = UNSAFE_MANUSCRIPT_PATHS.filter(([, v]) => typeof v === "string") as [string, string][];

  it.each(coverCases)("never removes a stored cover that is %s", async (_label, value) => {
    bookReadResult = { data: row({ cover_path: value }), error: null };
    await run(deleteBook(BOOK_ID));
    expect(storageCalls.filter((c) => c.bucket === "covers").flatMap((c) => c.paths)).not.toContain(value);
    expect(removals()).toEqual([{ op: "remove", bucket: "manuscripts", paths: [OWN_EPUB] }]);
    if (value.trim().length > 8) expect(loggedText()).not.toContain(value);
  });

  it.each(manuscriptCases)("never removes a stored manuscript that is %s", async (_label, value) => {
    bookReadResult = { data: row({ file_path: value }), error: null };
    await run(deleteBook(BOOK_ID));
    expect(storageCalls.filter((c) => c.bucket === "manuscripts").flatMap((c) => c.paths)).not.toContain(value);
    expect(removals()).toEqual([{ op: "remove", bucket: "covers", paths: [OWN_PNG] }]);
    if (value.trim().length > 8) expect(loggedText()).not.toContain(value);
  });

  it("never removes the same author's other book, or another author's key", async () => {
    bookReadResult = {
      data: row({ cover_path: `${USER_ID}/${OTHER_BOOK}-cover.jpeg`, file_path: `${OTHER_AUTHOR}/${BOOK_ID}.epub` }),
      error: null,
    };
    await run(deleteBook(BOOK_ID));
    expect(storageCalls).toEqual([]);
  });

  it("null paths: nothing to remove", async () => {
    bookReadResult = { data: row({ cover_path: null, file_path: null }), error: null };
    await run(deleteBook(BOOK_ID));
    expect(storageCalls).toEqual([]);
  });

  it.each([
    ["zero rows", { data: [], error: null }],
    ["two rows", { data: [{ id: BOOK_ID }, { id: OTHER_BOOK }], error: null }],
    ["null data", { data: null, error: null }],
    ["a mismatched row", { data: [{ id: OTHER_BOOK }], error: null }],
    ["a database error", { data: null, error: { code: "XXXXX", message: "boom" } }],
    ["a purchase race (23503)", { data: null, error: { code: "23503", message: "fk" } }],
  ])("%s returned by the delete: an error redirect and no Storage call", async (_label, result) => {
    deleteResult = result as Result;
    expect(await run(deleteBook(BOOK_ID))).toMatch(/^\/dashboard\?error=/);
    expect(storageCalls).toEqual([]);
  });

  it.each([
    ["a read error", { data: null, error: { message: "boom" } }],
    ["no row", { data: null, error: null }],
    ["another author's row", { data: row({ author_id: OTHER_AUTHOR }), error: null }],
    ["a different row id", { data: row({ id: OTHER_BOOK }), error: null }],
  ])("%s on the ownership read: no delete and no Storage call", async (_label, result) => {
    bookReadResult = result as Result;
    expect(await run(deleteBook(BOOK_ID))).toBe("/dashboard");
    expect(bookDeletes()).toEqual([]);
    expect(storageCalls).toEqual([]);
  });

  it("an upper-case spelling of the book id is refused before any write", async () => {
    expect(await run(deleteBook(BOOK_ID.toUpperCase()))).toBe("/dashboard");
    expect(dbWrites).toEqual([]);
    expect(storageCalls).toEqual([]);
  });
});

// ============================================================
// Stage A counted its one legacy cover only through lower(cover_path), so
// its raw spelling is unknown: every ASCII case of "jpeg" on the exact
// own-book stem must work, and must be removed exactly as stored.
const JPEG_SPELLINGS = Array.from({ length: 16 }, (_, mask) =>
  [..."jpeg"].map((c, i) => (mask & (1 << i) ? c.toUpperCase() : c)).join(""),
);

describe("legacy cover: every ASCII spelling of jpeg, bound to the exact author and book", () => {
  it.each(JPEG_SPELLINGS)("no-upload edit keeps .%s untouched", async (ext) => {
    bookReadResult = { data: row({ cover_path: `${USER_ID}/${BOOK_ID}-cover.${ext}` }), error: null };
    expect(await run(updateBook(BOOK_ID, editForm()))).toBe("/dashboard?success=Book+updated");
    expect(bookUpdates()[0].payload).not.toHaveProperty("cover_path");
    expect(storageCalls).toEqual([]);
  });

  it.each(JPEG_SPELLINGS)("manuscript-only replacement never touches .%s", async (ext) => {
    bookReadResult = { data: row({ cover_path: `${USER_ID}/${BOOK_ID}-cover.${ext}` }), error: null };
    expect(await run(updateBook(BOOK_ID, await withManuscript(editForm())))).toBe("/dashboard?success=Book+updated");
    expect(storageCalls).toEqual([{ op: "upload", bucket: "manuscripts", paths: [OWN_EPUB] }]);
  });

  it.each(JPEG_SPELLINGS)("cover replacement removes .%s exactly as stored, after the write", async (ext) => {
    const stored = `${USER_ID}/${BOOK_ID}-cover.${ext}`;
    bookReadResult = { data: row({ cover_path: stored }), error: null };
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe("/dashboard?success=Book+updated");
    expect(events).toEqual(["storage:upload:covers", "db:update:books", "storage:remove:covers"]);
    expect(removals()).toEqual([{ op: "remove", bucket: "covers", paths: [stored] }]);
    expect(bookUpdates()[0].filters).toContainEqual({ kind: "eq", column: "cover_path", value: stored });
  });

  it.each(JPEG_SPELLINGS)("deleteBook removes .%s exactly as stored", async (ext) => {
    const stored = `${USER_ID}/${BOOK_ID}-cover.${ext}`;
    bookReadResult = { data: row({ cover_path: stored }), error: null };
    expect(await run(deleteBook(BOOK_ID))).toBe("(no redirect)");
    expect(removals()).toEqual([
      { op: "remove", bucket: "covers", paths: [stored] },
      { op: "remove", bucket: "manuscripts", paths: [OWN_EPUB] },
    ]);
  });

  it.each(JPEG_SPELLINGS)("another book's or another author's .%s is never removed", async (ext) => {
    for (const other of [
      `${USER_ID}/${OTHER_BOOK}-cover.${ext}`,
      `${OTHER_AUTHOR}/${BOOK_ID}-cover.${ext}`,
      `${USER_ID.toUpperCase()}/${BOOK_ID}-cover.${ext}`,
      `${USER_ID}/${BOOK_ID.toUpperCase()}-cover.${ext}`,
      `${USER_ID}/../${USER_ID}/${BOOK_ID}-cover.${ext}`,
      `covers/${USER_ID}/${BOOK_ID}-cover.${ext}`,
      `${USER_ID}/${BOOK_ID}-cover.${ext}.${ext}`,
    ]) {
      storageCalls = [];
      bookReadResult = { data: row({ cover_path: other }), error: null };
      await run(updateBook(BOOK_ID, withCover(editForm(), JPG)));
      expect(removals()).toEqual([]);
      storageCalls = [];
      await run(deleteBook(BOOK_ID));
      expect(storageCalls.filter((c) => c.bucket === "covers")).toEqual([]);
    }
  });
});

// ============================================================
describe("a read error with a valid-looking row fails closed", () => {
  it("updateBook: no upload, no write, no removal", async () => {
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: { message: "read failed" } };
    const f = await withManuscript(withCover(editForm(), JPG));
    expect(await run(updateBook(BOOK_ID, f))).toBe("/dashboard");
    expect(storageCalls).toEqual([]);
    expect(dbWrites).toEqual([]);
  });

  it("deleteBook: no delete, no removal", async () => {
    bookReadResult = { data: row(), error: { message: "read failed" } };
    expect(await run(deleteBook(BOOK_ID))).toBe("/dashboard");
    expect(dbWrites).toEqual([]);
    expect(storageCalls).toEqual([]);
  });
});

// ============================================================
describe("a failed removal is logged without any key and never reverses the completed operation", () => {
  const HOSTILE = `${OTHER_AUTHOR}/../${USER_ID}/${BOOK_ID}-cover.JPEG`;
  function hostileStorageError(stored: string) {
    const nested = { path: stored, hostile: HOSTILE, keys: [stored, HOSTILE] };
    const error = new Error(`Object not found: ${stored} (${HOSTILE})`) as Error & Record<string, unknown>;
    error.name = "StorageApiError";
    error.status = 400;
    error.statusCode = `400 ${stored}`;
    error.details = nested;
    error.hint = `try ${HOSTILE}`;
    error.cause = new Error(`cause ${stored}`);
    error.originalError = { body: JSON.stringify(nested), response: { url: `https://x/${stored}` } };
    return error;
  }

  it("updateBook: success redirect, the write stands, the log carries no key", async () => {
    const stored = `${USER_ID}/${BOOK_ID}-cover.JPEG`;
    bookReadResult = { data: row({ cover_path: stored }), error: null };
    removeError = hostileStorageError(stored);
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe("/dashboard?success=Book+updated");
    expect(bookUpdates()).toHaveLength(1);
    expect(removals()).toEqual([{ op: "remove", bucket: "covers", paths: [stored] }]);
    const text = loggedText();
    expect(text).toContain("updateBook: failed to remove superseded storage objects");
    for (const secret of [stored, HOSTILE, USER_ID, BOOK_ID, "Object not found", "StorageApiError"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("deleteBook: the deletion stands, the log carries no key", async () => {
    removeError = hostileStorageError(OWN_EPUB);
    expect(await run(deleteBook(BOOK_ID))).toBe("(no redirect)");
    expect(bookDeletes()).toHaveLength(1);
    expect(removals()).toHaveLength(2);
    const text = loggedText();
    expect(text).toContain("deleteBook: failed to remove superseded storage objects");
    for (const secret of [OWN_EPUB, OWN_PNG, HOSTILE, USER_ID, "Object not found"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("createBook: the new book stands, the log carries no key", async () => {
    storedObjects[`manuscripts:${TEMP_EPUB}`] = await validEpub();
    removeError = hostileStorageError(TEMP_EPUB);
    const f = withCover(editForm(), PNG);
    f.set("manuscriptStoragePath", TEMP_EPUB);
    expect(await run(createBook(f))).toBe("/dashboard");
    expect(dbWrites.filter((w) => w.op === "insert")).toHaveLength(1);
    const text = loggedText();
    expect(text).toContain("createBook: failed to remove superseded storage objects");
    for (const secret of [TEMP_EPUB, HOSTILE, USER_ID]) {
      expect(text).not.toContain(secret);
    }
  });
});

// ============================================================
describe("no book action ever moves, copies, signs or downloads a stored key", () => {
  it("across update and delete flows, Storage sees only uploads of new keys, temp downloads and proven removals", async () => {
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: null };
    await run(updateBook(BOOK_ID, editForm()));
    await run(updateBook(BOOK_ID, withCover(editForm(), JPG)));
    await run(updateBook(BOOK_ID, await withManuscript(editForm())));
    await run(deleteBook(BOOK_ID));
    expect(storageCalls.map((c) => c.op).filter((op) => !["upload", "remove"].includes(op))).toEqual([]);
  });
});
