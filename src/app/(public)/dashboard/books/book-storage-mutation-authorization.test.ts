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
import { canonicalBookCoverPath, canonicalBookManuscriptPath, isNewBookCoverPath } from "@/lib/book-storage-path";

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
// ADMIN-3-REVIEW: book_reviews reads/writes replaced by a settable
// double (default: nothing pending, approval valid); see
// src/lib/book-reviews-test-double.ts.
vi.mock("@/lib/book-reviews", async (importOriginal) => {
  const { bookReviewsDouble } = await import("@/lib/book-reviews-test-double");
  return bookReviewsDouble(await importOriginal<object>());
});
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/recovery-guard", () => ({ redirectIfRecoverySessionActive: vi.fn() }));
// ADMIN-2-TAKEDOWN: deleteBook reads the book's active takedown; none
// here (its own cases are in unpublish-delete.test.ts).
vi.mock("@/lib/book-takedowns", () => ({ getActiveTakedownState: async () => ({ kind: "none" }) }));

type Filter = { kind: string; column: string; value: unknown };
type DbWrite = { table: string; op: string; payload: unknown; filters: Filter[] };
type StorageCall = { op: string; bucket: string; paths: unknown[] };
type Result = { data: unknown; error: unknown };

const events: string[] = [];
let storageCalls: StorageCall[] = [];
let dbWrites: DbWrite[] = [];
let signedInUserId: string | null = USER_ID;
let bookReadResult: Result;
// ADMIN-3-REVIEW (C): the published-bundle membership read.
let bundleBooksResult: Result = { data: [], error: null };
let updateResult: Result | null;
let deleteResult: Result | null;
let removeError: unknown = null;
let failUploadsTo: Set<string> = new Set();
let storedObjects: Record<string, Buffer> = {};
// PEN-2 (L10): every Storage call made through the catalog writer
// (service role), as "<op>:<bucket>".
let writerStorageOps: string[] = [];

function query(table: string) {
  const filters: Filter[] = [];
  let op = "select";
  let payload: unknown = undefined;
  let returning = false;
  const resolve = (): Result => {
    if (op === "select") {
      if (table === "books") return bookReadResult;
      if (table === "bundle_books") return bundleBooksResult;
      if (table === "purchases" || table === "author_book_purchases") return { data: null, error: null, count: 0 } as Result;
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
      return failUploadsTo.has(`${bucket}:${String(path)}`) || failUploadsTo.has(`${bucket}:*`)
        ? { error: { message: "upload failed" } }
        : { error: null };
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
// PEN-NAMES-1: the pen name box resolves through the server-only pen
// name writer; here it always resolves to the author's default.
vi.mock("@/lib/pen-name-write-client", () => ({
  resolveOwnPenNameId: async () => ({ ok: true, penNameId: "f0000000-0000-4000-8000-00000000pen0" }),
}));
vi.mock("@/lib/catalog-write-client", async () => {
  const { catalogWriterReplayingOnto } = await import("@/lib/catalog-write-test-double");
  return {
    createCatalogWriteClient: () =>
      catalogWriterReplayingOnto(
        () => sessionClient,
        (op, bucket) => writerStorageOps.push(`${op}:${bucket}`),
      ),
  };
});

const { createBook, updateBook, deleteBook, cancelBookReview } = await import("./actions");
const { bookReviewsDoubleState, resetBookReviewsDouble } = await import("@/lib/book-reviews-test-double");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]);
const TEMP_EPUB = `${USER_ID}/tmp/epub/e5f6a7b8-7777-4777-8777-abcdef777777.epub`;
const TEMP_COVER = `${USER_ID}/tmp/cover/f6a7b8c9-8888-4888-8888-abcdef888888.png`;

const OWN_PNG = canonicalBookCoverPath(USER_ID, BOOK_ID, "png");
const OWN_JPG = canonicalBookCoverPath(USER_ID, BOOK_ID, "jpg");
const OWN_EPUB = canonicalBookManuscriptPath(USER_ID, BOOK_ID);
const LEGACY_JPEG = `${USER_ID}/${BOOK_ID}-cover.jpeg`;
// PEN-2 (L10): a new cover key is `<random uuid>/cover.<ext>`.
const NEW_JPG = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/cover\.jpg$/);
const NEW_PNG = expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/cover\.png$/);
// ADMIN-3-REVIEW (M5): a new manuscript key is versioned,
// `<author>/<book>/<random uuid>.epub`, written by the catalog writer
// before the row write; the superseded own key is removed after it.
const NEW_EPUB = expect.stringMatching(
  new RegExp(`^${USER_ID}/${BOOK_ID}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.epub$`),
);
const RANDOM_STORED = "0f0e0d0c-0b0a-4908-8706-050403020100/cover.png";
const uploadedCoverKey = () => String(storageCalls.find((c) => c.op === "upload" && c.bucket === "covers")?.paths[0]);

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
  failUploadsTo = new Set();
  storedObjects = {};
  writerStorageOps = [];
  consoleOutput = [];
  bundleBooksResult = { data: [], error: null };
  resetBookReviewsDouble();
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
    expect(payload.file_path).toEqual(NEW_EPUB);
    expect(payload).not.toHaveProperty("cover_path");
    expect(storageCalls).toEqual([
      { op: "upload", bucket: "manuscripts", paths: [NEW_EPUB] },
      { op: "remove", bucket: "manuscripts", paths: [OWN_EPUB] },
    ]);
    expect(writerStorageOps).toEqual(["upload:manuscripts", "remove:manuscripts"]);
  });

  it("cover only: writes only cover_path, never re-persists or removes the manuscript", async () => {
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe("/dashboard?success=Book+updated");
    const payload = bookUpdates()[0].payload as Record<string, unknown>;
    expect(payload.cover_path).toEqual(NEW_JPG);
    expect(payload).not.toHaveProperty("file_path");
    expect(storageCalls).toEqual([
      { op: "upload", bucket: "covers", paths: [NEW_JPG] },
      { op: "remove", bucket: "covers", paths: [OWN_PNG] },
    ]);
  });

  // PEN-2 (L10): a fresh random folder plus the verified bytes' extension;
  // nothing from the account, the book or the file name.
  it("the key is a fresh random folder and the verified bytes' extension -- not the file name, account or book", async () => {
    await run(updateBook(BOOK_ID, withCover(editForm(), PNG)));
    expect(storageCalls[0]).toEqual({ op: "upload", bucket: "covers", paths: [NEW_PNG] });
    expect(uploadedCoverKey()).not.toContain(USER_ID);
    expect(uploadedCoverKey()).not.toContain(BOOK_ID);
    expect(uploadedCoverKey()).not.toContain("anything");
  });

  it("covers are uploaded and removed with the catalog writer (service role, C9), never the session", async () => {
    await run(updateBook(BOOK_ID, withCover(editForm(), JPG)));
    expect(writerStorageOps).toEqual(["upload:covers", "remove:covers"]);
  });

  // PEN-2 (L10): every replace gets a new key, so even a same-extension
  // replace never overwrites the live object; the previous one is removed
  // after the proven write.
  it("a same-extension replace gets a new key and removes the previous object after the write", async () => {
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), PNG)))).toBe("/dashboard?success=Book+updated");
    expect(uploadedCoverKey()).not.toBe(OWN_PNG);
    expect(events).toEqual(["storage:upload:covers", "db:update:books", "storage:remove:covers"]);
    expect(removals()).toEqual([{ op: "remove", bucket: "covers", paths: [OWN_PNG] }]);
  });

  it("a new-shape stored cover (read from the author's own row) is replaced and removed after the write", async () => {
    bookReadResult = { data: row({ cover_path: RANDOM_STORED }), error: null };
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe("/dashboard?success=Book+updated");
    expect(bookUpdates()[0].filters).toContainEqual({ kind: "eq", column: "cover_path", value: RANDOM_STORED });
    expect(removals()).toEqual([{ op: "remove", bucket: "covers", paths: [RANDOM_STORED] }]);
  });

  it("two replaces never reuse a key", async () => {
    await run(updateBook(BOOK_ID, withCover(editForm(), PNG)));
    const first = uploadedCoverKey();
    storageCalls = [];
    await run(updateBook(BOOK_ID, withCover(editForm(), PNG)));
    expect(isNewBookCoverPath(first)).toBe(true);
    expect(uploadedCoverKey()).not.toBe(first);
  });

  it("the exact own-book legacy .jpeg cover is removed only after the write, and never re-created", async () => {
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: null };
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe("/dashboard?success=Book+updated");
    expect(events).toEqual(["storage:upload:covers", "db:update:books", "storage:remove:covers"]);
    expect(removals()).toEqual([{ op: "remove", bucket: "covers", paths: [LEGACY_JPEG] }]);
    expect(everyStorageKey().filter((k) => String(k).endsWith(".jpeg"))).toEqual([LEGACY_JPEG]);
    expect((bookUpdates()[0].payload as Record<string, unknown>).cover_path).toEqual(NEW_JPG);
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
    // ADMIN-3-REVIEW (N3): the superseded own manuscript key goes first
    // (retention cleanup), then the old cover, then the temporary keys.
    expect(removals()).toEqual([
      { op: "remove", bucket: "manuscripts", paths: [OWN_EPUB] },
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
    expect(storageCalls).toEqual([{ op: "upload", bucket: "covers", paths: [NEW_JPG] }]);
    expect((bookUpdates()[0].payload as Record<string, unknown>).cover_path).toEqual(NEW_JPG);
    if (value.trim().length > 8) expect(loggedText()).not.toContain(value);
  });

  it.each(manuscriptCases)("stored manuscript %s: replacement succeeds, the old value is left untouched", async (_label, value) => {
    bookReadResult = { data: row({ file_path: value }), error: null };
    expect(await run(updateBook(BOOK_ID, await withManuscript(editForm())))).toBe(
      "/dashboard?success=Book+updated",
    );
    expect(storageCalls).toEqual([{ op: "upload", bucket: "manuscripts", paths: [NEW_EPUB] }]);
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
  ])("%s returned: no success, the stored cover is kept and only the new upload is removed", async (_label, result) => {
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: null };
    updateResult = result as Result;
    const target = await run(updateBook(BOOK_ID, withCover(editForm(), JPG)));
    expect(target).toMatch(new RegExp(`^/dashboard/books/${BOOK_ID}/edit\\?error=`));
    expect(removals()).toEqual([{ op: "remove", bucket: "covers", paths: [uploadedCoverKey()] }]);
    expect(removals().flatMap((c) => c.paths)).not.toContain(LEGACY_JPEG);
  });

  it("a write error: no success, the stored cover is kept and only the new upload is removed", async () => {
    bookReadResult = { data: row({ cover_path: LEGACY_JPEG }), error: null };
    updateResult = { data: null, error: { message: "db exploded" } };
    const target = await run(updateBook(BOOK_ID, withCover(editForm(), JPG)));
    expect(target).toMatch(new RegExp(`^/dashboard/books/${BOOK_ID}/edit\\?error=`));
    expect(removals()).toEqual([{ op: "remove", bucket: "covers", paths: [uploadedCoverKey()] }]);
  });

  // PEN-2 (L10): when the compare-and-set misses, the new upload is the
  // unreferenced object and is removed; the previous object stays.
  it("a concurrent cover change (compare-and-set matches no row): the old cover stays, the new upload is removed", async () => {
    bookReadResult = { data: row({ cover_path: OWN_JPG }), error: null };
    updateResult = { data: [], error: null };
    await run(updateBook(BOOK_ID, withCover(editForm(), PNG)));
    expect(removals()).toEqual([{ op: "remove", bucket: "covers", paths: [uploadedCoverKey()] }]);
    expect(isNewBookCoverPath(uploadedCoverKey())).toBe(true);
    expect(writerStorageOps).toEqual(["upload:covers", "remove:covers"]);
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

  // PEN-2 (L10): the cover gets a fresh random key, uploaded with the
  // catalog writer. ADMIN-3-REVIEW (M5): so does the manuscript, under a
  // versioned key in the new book's own folder (authors may write only
  // under <uid>/tmp/).
  it("writes a random cover key and a versioned manuscript key for the new id, both with the catalog writer", async () => {
    expect(await run(createBook(await createForm()))).toBe("/dashboard");
    const insert = dbWrites.find((w) => w.op === "insert")!;
    const id = (insert.payload as { id: string }).id;
    const versioned = expect.stringMatching(
      new RegExp(`^${USER_ID}/${id}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.epub$`),
    );
    expect(insert.payload).toMatchObject({ author_id: USER_ID, cover_path: NEW_PNG, file_path: versioned });
    expect(everyStorageKey()).toEqual([NEW_PNG, versioned]);
    expect(everyStorageKey()).not.toContain(canonicalBookManuscriptPath(USER_ID, id));
    expect(uploadedCoverKey()).not.toContain(USER_ID);
    expect(uploadedCoverKey()).not.toContain(id);
    expect(uploadedCoverKey()).not.toBe(canonicalBookCoverPath(USER_ID, id, "png"));
    expect(writerStorageOps).toEqual(["upload:covers", "upload:manuscripts"]);
  });

  it("an insert failure removes the new cover and manuscript uploads", async () => {
    sessionClient.from = ((table: string) => {
      const q = query(table) as Record<string, unknown>;
      if (table === "books") {
        q.insert = () => ({ select: async () => ({ data: null, error: { message: "boom" } }) });
      }
      return q;
    }) as typeof sessionClient.from;
    try {
      expect(await run(createBook(await createForm()))).toMatch(/^\/dashboard\/books\/new\?error=/);
    } finally {
      sessionClient.from = (table: string) => query(table);
    }
    const newManuscript = String(storageCalls.find((c) => c.op === "upload" && c.bucket === "manuscripts")?.paths[0]);
    expect(removals()).toEqual([
      { op: "remove", bucket: "covers", paths: [uploadedCoverKey()] },
      { op: "remove", bucket: "manuscripts", paths: [newManuscript] },
    ]);
    expect(writerStorageOps).toEqual(["upload:covers", "upload:manuscripts", "remove:covers", "remove:manuscripts"]);
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

  // PEN-2 (L10): a new-shape cover read from the author's own row is
  // removed, with the catalog writer (C9: no user write policy on covers).
  it("removes a new-shape stored cover with the catalog writer", async () => {
    bookReadResult = { data: row({ cover_path: RANDOM_STORED }), error: null };
    await run(deleteBook(BOOK_ID));
    expect(removals()).toEqual([
      { op: "remove", bucket: "covers", paths: [RANDOM_STORED] },
      { op: "remove", bucket: "manuscripts", paths: [OWN_EPUB] },
    ]);
    // ADMIN-3-REVIEW (N3, P5): manuscripts are removed by the catalog
    // writer too (no author delete policy outside <uid>/tmp/).
    expect(writerStorageOps).toEqual(["remove:covers", "remove:manuscripts"]);
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
    expect(storageCalls).toEqual([
      { op: "upload", bucket: "manuscripts", paths: [NEW_EPUB] },
      { op: "remove", bucket: "manuscripts", paths: [OWN_EPUB] },
    ]);
    expect(storageCalls.some((c) => c.bucket === "covers")).toBe(false);
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

// ============================================================
// QA-FIX-3: a failed save never changes the live cover or manuscript.
describe("updateBook never overwrites a live file before the save is proven", () => {
  it("a rejected manuscript uploads nothing, not even a valid new cover", async () => {
    const f = withCover(editForm(), JPG);
    f.set("manuscript", new File([new Uint8Array(Buffer.from("not a zip"))], "book.epub"));
    const target = await run(updateBook(BOOK_ID, f));
    expect(target).toMatch(new RegExp(`^/dashboard/books/${BOOK_ID}/edit\\?error=`));
    expect(storageCalls).toEqual([]);
    expect(dbWrites).toEqual([]);
  });

  // PEN-2 (L10): a cover is never same-key any more (new random key on
  // every replace), so it always goes before the write. ADMIN-3-REVIEW
  // (M5): neither is a manuscript -- a versioned key before the write,
  // and the superseded own key removed only after it.
  it("the new cover and the new manuscript go before the row update; old keys are removed after it", async () => {
    const f = await withManuscript(withCover(editForm(), PNG));
    expect(await run(updateBook(BOOK_ID, f))).toBe("/dashboard?success=Book+updated");
    expect(events).toEqual([
      "storage:upload:covers",
      "storage:upload:manuscripts",
      "db:update:books",
      "storage:remove:manuscripts",
      "storage:remove:covers",
    ]);
  });

  it("a new-key cover is still uploaded before the row update, so the row never points at a missing file", async () => {
    bookReadResult = { data: row({ cover_path: OWN_PNG, file_path: null }), error: null };
    const f = await withManuscript(withCover(editForm(), JPG));
    expect(await run(updateBook(BOOK_ID, f))).toBe("/dashboard?success=Book+updated");
    expect(events).toEqual([
      "storage:upload:covers",
      "storage:upload:manuscripts",
      "db:update:books",
      "storage:remove:covers",
    ]);
  });

  it.each([
    ["a write error", { data: null, error: { message: "db exploded" } }],
    ["zero rows", { data: [], error: null }],
  ])("%s: the live files are never touched and the new uploads are removed", async (_label, result) => {
    updateResult = result as Result;
    const f = await withManuscript(withCover(editForm(), PNG));
    const target = await run(updateBook(BOOK_ID, f));
    expect(target).toMatch(new RegExp(`^/dashboard/books/${BOOK_ID}/edit\\?error=`));
    expect(storageCalls.filter((c) => c.op === "upload")).toEqual([
      { op: "upload", bucket: "covers", paths: [NEW_PNG] },
      { op: "upload", bucket: "manuscripts", paths: [NEW_EPUB] },
    ]);
    const newManuscript = String(storageCalls.find((c) => c.op === "upload" && c.bucket === "manuscripts")?.paths[0]);
    expect(removals()).toEqual([
      { op: "remove", bucket: "covers", paths: [uploadedCoverKey()] },
      { op: "remove", bucket: "manuscripts", paths: [newManuscript] },
    ]);
    expect(everyStorageKey()).not.toContain(OWN_PNG);
    expect(everyStorageKey()).not.toContain(OWN_EPUB);
  });

  // ADMIN-3-REVIEW (M5): there is no in-place manuscript upload any
  // more; a failed new-key manuscript upload stops before the write.
  it("a new manuscript upload that fails stops before the row update and touches nothing else", async () => {
    failUploadsTo = new Set(["manuscripts:*"]);
    const target = await run(updateBook(BOOK_ID, await withManuscript(editForm())));
    expect(target).toMatch(new RegExp(`^/dashboard/books/${BOOK_ID}/edit\\?error=`));
    expect(dbWrites).toEqual([]);
    expect(removals()).toEqual([]);
    expect(everyStorageKey()).not.toContain(OWN_EPUB);
  });

  it("a new-key upload that fails stops before the row update", async () => {
    failUploadsTo = new Set(["covers:*"]);
    const target = await run(updateBook(BOOK_ID, withCover(editForm(), JPG)));
    expect(target).toBe(`/dashboard/books/${BOOK_ID}/edit?error=Could+not+upload+your+cover+image.+Please+try+again`);
    expect(dbWrites).toEqual([]);
    expect(removals()).toEqual([]);
  });
});

// ============================================================
// ADMIN-3-REVIEW (C, D, S3, S5, E): a new file or cover takes a LIVE book
// out of the Bookstore until Librum approves it; a book waiting for
// review gets its snapshot replaced; text-only edits are unchanged.
describe("updateBook and review (ADMIN-3)", () => {
  const SAVED_LIVE = `/dashboard?success=${encodeURIComponent(
    "Saved. Your book is out of the Bookstore until Librum approves the new file or cover.",
  )}`;
  const fns = () => bookReviewsDoubleState.calls.map((c) => c.fn);

  beforeEach(() => {
    bookReadResult = { data: row({ status: "published" }), error: null };
  });

  it("a live book's new cover: one write back to draft, then a review request", async () => {
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe(SAVED_LIVE);
    const [update] = bookUpdates();
    expect(update.payload).toMatchObject({ cover_path: NEW_JPG, status: "draft", librum_choice_at: null });
    expect(fns()).toEqual(["requestBookReview"]);
    expect(events.indexOf("db:update:books")).toBeLessThan(events.indexOf("storage:remove:covers"));
  });

  it("a live book's new manuscript: draft, review request, then retention cleanup of the superseded key", async () => {
    expect(await run(updateBook(BOOK_ID, await withManuscript(editForm())))).toBe(SAVED_LIVE);
    expect(bookUpdates()[0].payload).toMatchObject({ file_path: NEW_EPUB, status: "draft", librum_choice_at: null });
    expect(fns()).toEqual(["requestBookReview", "removeUnretainedManuscripts"]);
    expect(removals()).toEqual([{ op: "remove", bucket: "manuscripts", paths: [OWN_EPUB] }]);
  });

  it("a failed review request keeps the draft and tells the author to press Send for review", async () => {
    bookReviewsDoubleState.requestResult = { ok: false, reason: "failed" };
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?success=${encodeURIComponent("Saved. Press Send for review when you're ready.")}`,
    );
    expect(bookUpdates()).toHaveLength(1);
  });

  it("a live book in a published bundle cannot change its files: refused before any upload", async () => {
    bundleBooksResult = { data: [{ bundle_id: "b1" }], error: null };
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?error=${encodeURIComponent(
        "This book is part of a published bundle. Unpublish the bundle first, then change the file or cover.",
      )}`,
    );
    expect(storageCalls).toEqual([]);
    expect(dbWrites).toEqual([]);
  });

  it("an unreadable bundle membership fails closed", async () => {
    bundleBooksResult = { data: null, error: { message: "down" } };
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toMatch(/\/edit\?error=Something\+went\+wrong/);
    expect(storageCalls).toEqual([]);
    expect(dbWrites).toEqual([]);
  });

  it("a text-only edit of a live book stays live: no status, no review", async () => {
    expect(await run(updateBook(BOOK_ID, editForm()))).toBe("/dashboard?success=Book+updated");
    expect(bookUpdates()[0].payload).not.toHaveProperty("status");
    expect(bookReviewsDoubleState.calls).toEqual([]);
  });

  it("a draft waiting for review: its snapshot is replaced with the new files", async () => {
    bookReadResult = { data: row({ status: "draft" }), error: null };
    bookReviewsDoubleState.pending = true;
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe("/dashboard?success=Book+updated");
    expect(fns()).toEqual(["getBookReviewState", "requestBookReview"]);
    expect(bookUpdates()[0].payload).toMatchObject({ status: "draft" });
  });

  it("a draft not waiting for review is not sent for review by a file change", async () => {
    bookReadResult = { data: row({ status: "draft" }), error: null };
    expect(await run(updateBook(BOOK_ID, withCover(editForm(), JPG)))).toBe("/dashboard?success=Book+updated");
    expect(fns()).toEqual(["getBookReviewState"]);
  });

  it.each(["LB462", "LB463"])("%s on the write: 'changed while editing', the new uploads removed", async (code) => {
    updateResult = { data: null, error: { code, message: "x" } };
    expect(await run(updateBook(BOOK_ID, await withManuscript(withCover(editForm(), PNG))))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?error=${encodeURIComponent("Your book changed while you were editing. Reload and try again.")}`,
    );
    expect(removals().map((c) => c.bucket)).toEqual(["covers", "manuscripts"]);
    expect(everyStorageKey()).not.toContain(OWN_EPUB);
    expect(bookReviewsDoubleState.calls).toEqual([]);
  });

  it("the write is a compare-and-set on the file_path it read", async () => {
    await run(updateBook(BOOK_ID, await withManuscript(editForm())));
    expect(bookUpdates()[0].filters).toContainEqual({ kind: "eq", column: "file_path", value: OWN_EPUB });
  });
});

describe("cancelBookReview (ADMIN-3, E)", () => {
  it("withdraws the pending review on the author's session and says so", async () => {
    expect(await run(cancelBookReview(BOOK_ID))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?success=${encodeURIComponent("Review cancelled. Your book is a draft again.")}`,
    );
    expect(bookReviewsDoubleState.calls).toEqual([{ fn: "withdrawBookReview", bookId: BOOK_ID }]);
    expect(dbWrites).toEqual([]);
    expect(storageCalls).toEqual([]);
  });

  it("not waiting: says so", async () => {
    bookReviewsDoubleState.withdrawResult = { ok: false, reason: "not_pending" };
    expect(await run(cancelBookReview(BOOK_ID))).toBe(
      `/dashboard/books/${BOOK_ID}/edit?error=${encodeURIComponent("This book isn't waiting for review.")}`,
    );
  });

  it("signed out: to login, nothing asked", async () => {
    signedInUserId = null;
    expect(await run(cancelBookReview(BOOK_ID))).toBe("/login");
    expect(bookReviewsDoubleState.calls).toEqual([]);
  });
});

// ADMIN-3-REVIEW (N3, P5): a deleted book's review history may name more
// of its own manuscript keys; they are read (trusted client) BEFORE the
// delete and removed after it. A failed read deletes nothing.
describe("deleteBook and review snapshots (ADMIN-3)", () => {
  const V_OLD = `${USER_ID}/${BOOK_ID}/0f0e0d0c-0b0a-4908-8706-050403020100.epub`;

  it("removes the current file and every own snapshot key, once, after the delete", async () => {
    bookReviewsDoubleState.snapshots = [
      { book_id: BOOK_ID, file_path: V_OLD, status: "approved" },
      { book_id: BOOK_ID, file_path: OWN_EPUB, status: "cancelled" },
      { book_id: BOOK_ID, file_path: `${OTHER_AUTHOR}/${BOOK_ID}.epub`, status: "cancelled" },
    ];
    await run(deleteBook(BOOK_ID));
    expect(removals()).toEqual([
      { op: "remove", bucket: "covers", paths: [OWN_PNG] },
      { op: "remove", bucket: "manuscripts", paths: [OWN_EPUB, V_OLD] },
    ]);
    expect(events.indexOf("db:delete:books")).toBeLessThan(events.indexOf("storage:remove:manuscripts"));
    expect(bookReviewsDoubleState.calls).toEqual([{ fn: "readReviewSnapshots", bookId: BOOK_ID }]);
  });

  it("a failed snapshot read deletes nothing and removes nothing", async () => {
    bookReviewsDoubleState.snapshotsOk = false;
    expect(await run(deleteBook(BOOK_ID))).toBe("/dashboard?error=Could+not+delete+that+book+right+now");
    expect(bookDeletes()).toEqual([]);
    expect(storageCalls).toEqual([]);
  });
});
