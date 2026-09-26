import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

// PAID-REPRICING-1: the published-repricing gate and the publish/update
// compare-and-set, for books AND bundles, driven through the real Server
// Actions against a small in-memory table that applies `.eq()` / `.is()`
// filters with SQL semantics and returns the rows an UPDATE changed.
//
// That table is the point. A double that answers every update with
// "success" can prove a filter was REQUESTED, not that it WORKED: the
// race tests below need a write whose outcome depends on the row state it
// finds when it lands. `eq(col, null)` therefore matches nothing, exactly
// as `col = NULL` does in Postgres, and `is(col, null)` matches null.

class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ __admin: true }) }));
vi.mock("@/lib/email", () => ({ sendNewBookEmails: vi.fn(async () => undefined) }));

type Row = Record<string, unknown>;
type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "is"; column: string; value: null }
  | { kind: "in"; column: string; value: unknown[] };
// CATALOG-WRITE-AUTH-1: `via` records which client issued the write --
// the author's session, or the trusted catalog writer. Both operate on
// the same in-memory tables, so the race tests keep their meaning.
type Via = "session" | "catalog-writer";
type Write = {
  table: string;
  op: "insert" | "update" | "delete" | "rpc";
  payload?: unknown;
  filters: Filter[];
  via: Via;
};
type Interceptor = { table: string; op: "update"; run: () => Promise<void> };

const USER_ID = "a1b2c3d4-1111-4111-8111-abcdef111111";
const BOOK_ID = "c3d4e5f6-2222-4222-8222-abcdef222222";
const BUNDLE_ID = "bundle-1";

let tables: Record<string, Row[]> = {};
let writes: Write[] = [];
let uploads: string[] = [];
let interceptor: Interceptor | null = null;

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === "eq") return f.value !== null && row[f.column] === f.value;
    if (f.kind === "is") return row[f.column] === null;
    return f.value.includes(row[f.column]);
  });
}

function builder(table: string, via: Via = "session") {
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: unknown;
  let columns = "*";
  let returning = false;
  let single: "single" | "maybe" | null = null;
  const filters: Filter[] = [];

  async function execute() {
    const rows = (tables[table] ??= []);
    if (op === "select") {
      let data: Row[] = rows.filter((r) => matches(r, filters)).map((r) => ({ ...r }));
      if (table === "bundle_books" && columns.includes("books(")) {
        data = data.map((r) => ({
          ...r,
          books: tables.books.find((b) => b.id === r.book_id) ?? null,
        }));
      }
      if (single === "single") {
        return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: "PGRST116" } };
      }
      if (single === "maybe") return { data: data[0] ?? null, error: null };
      return { data, error: null };
    }
    if (op === "insert") {
      writes.push({ table, op, payload, filters: [], via });
      const list = Array.isArray(payload) ? payload : [payload];
      rows.push(...(list as Row[]).map((r) => ({ ...r })));
      return { data: null, error: null };
    }
    if (op === "delete") {
      writes.push({ table, op, filters: [...filters], via });
      tables[table] = rows.filter((r) => !matches(r, filters));
      return { data: null, error: null };
    }
    // update: a pending concurrent action lands first, then this write
    // is applied to whatever state it left.
    if (interceptor && interceptor.table === table) {
      const pending = interceptor;
      interceptor = null;
      await pending.run();
    }
    writes.push({ table, op, payload, filters: [...filters], via });
    const changed = rows.filter((r) => matches(r, filters));
    for (const r of changed) Object.assign(r, payload as Row);
    return { data: returning ? changed.map((r) => ({ id: r.id })) : null, error: null };
  }

  const chain: Record<string, unknown> = {
    select: (cols?: string) => {
      if (op === "select") columns = cols ?? "*";
      else returning = true;
      return chain;
    },
    insert: (p: unknown) => ((op = "insert"), (payload = p), chain),
    update: (p: unknown) => ((op = "update"), (payload = p), chain),
    delete: () => ((op = "delete"), chain),
    eq: (column: string, value: unknown) => (filters.push({ kind: "eq", column, value }), chain),
    is: (column: string, value: null) => (filters.push({ kind: "is", column, value }), chain),
    in: (column: string, value: unknown[]) => (filters.push({ kind: "in", column, value }), chain),
    order: () => chain,
    returns: () => chain,
    single: () => ((single = "single"), chain),
    maybeSingle: () => ((single = "maybe"), chain),
    then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
      execute().then(onFulfilled, onRejected),
  };
  return chain;
}

const client = {
  auth: { getUser: async () => ({ data: { user: { id: USER_ID } } }) },
  from: (table: string) => builder(table),
  storage: {
    from: (bucket: string) => ({
      upload: async (path: string) => {
        uploads.push(`${bucket}:${path}`);
        return { error: null };
      },
      remove: async () => ({ error: null }),
      download: async () => ({ data: null, error: { message: "not used" } }),
    }),
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client }));
// BUNDLE-MEMBERSHIP-AUTH-1: updateBundle saves details AND membership
// through ONE service-role function, update_bundle_with_membership. This
// double applies it to the same in-memory tables with the function's
// semantics: a pending concurrent action lands first (the function would
// wait for its lock), then the compare-and-set is evaluated on the row it
// finds, then books are validated, and only then is anything written --
// all or nothing, as one transaction.
const catalogWriter = {
  from: (table: string) => builder(table, "catalog-writer"),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    if (fn !== "update_bundle_with_membership") {
      return { data: null, error: { code: "42883", message: `unexpected function ${fn}` } };
    }
    if (interceptor && interceptor.table === "bundles") {
      const pending = interceptor;
      interceptor = null;
      await pending.run();
    }
    const bundleId = args.p_bundle_id as string;
    const authorId = args.p_author_id as string;
    const bookIds = args.p_book_ids as string[];
    writes.push({
      table: "bundles",
      op: "rpc",
      payload: { fn, args },
      filters: [
        { kind: "eq", column: "id", value: bundleId },
        { kind: "eq", column: "author_id", value: authorId },
      ],
      via: "catalog-writer",
    });
    const row = (tables.bundles ?? []).find((r) => r.id === bundleId && r.author_id === authorId);
    if (!row) return { data: null, error: { code: "42501", message: "bundle not found for this author" } };
    if (
      (args.p_expected_status !== null && row.status !== args.p_expected_status) ||
      (args.p_check_expected_price_all === true && row.price_all !== args.p_expected_price_all)
    ) {
      return { data: null, error: { code: "LB409", message: "the bundle changed since it was read" } };
    }
    const valid = new Set(
      (tables.books ?? [])
        .filter((b) => bookIds.includes(b.id as string) && b.author_id === authorId && b.status === "published")
        .map((b) => b.id),
    );
    if (new Set(bookIds).size !== bookIds.length || bookIds.length < 2 || valid.size !== bookIds.length) {
      return { data: null, error: { code: "42501", message: "every book must be the author's own published book" } };
    }
    Object.assign(row, { title: args.p_title, description: args.p_description, price_all: args.p_price_all });
    writes.push({ table: "bundle_books", op: "rpc", payload: { fn, args }, filters: [], via: "catalog-writer" });
    tables.bundle_books = [
      ...(tables.bundle_books ?? []).filter((r) => r.bundle_id !== bundleId),
      ...bookIds.map((id) => ({ bundle_id: bundleId, book_id: id })),
    ];
    return {
      data: bookIds.map((id) => ({
        member_bundle_id: bundleId,
        member_book_id: id,
        bundle_title: row.title,
        bundle_description: row.description,
        bundle_price_all: row.price_all,
        bundle_status: row.status,
      })),
      error: null,
    };
  },
};
vi.mock("@/lib/catalog-write-client", () => ({ createCatalogWriteClient: () => catalogWriter }));

const { updateBook, publishBook } = await import("./books/actions");
const { updateBundle, publishBundle } = await import("./bundles/actions");
const { PAID_REPRICING_UNAVAILABLE_MESSAGE, CATALOG_ROW_CHANGED_MESSAGE } = await import(
  "@/lib/paid-repricing"
);

const BOOK_DENIED = `/dashboard/books/${BOOK_ID}/edit?error=${encodeURIComponent(PAID_REPRICING_UNAVAILABLE_MESSAGE)}`;
const BOOK_CHANGED = `/dashboard/books/${BOOK_ID}/edit?error=${encodeURIComponent(CATALOG_ROW_CHANGED_MESSAGE)}`;
const BOOK_SAVED = "/dashboard?success=Book+updated";
const BUNDLE_DENIED = `/dashboard/bundles/${BUNDLE_ID}/edit?error=${encodeURIComponent(PAID_REPRICING_UNAVAILABLE_MESSAGE)}`;
const BUNDLE_CHANGED = `/dashboard/bundles/${BUNDLE_ID}/edit?error=${encodeURIComponent(CATALOG_ROW_CHANGED_MESSAGE)}`;
const BUNDLE_SAVED = "/dashboard/bundles?success=Bundle+updated";

function seedBook(overrides: Row) {
  tables.books = [
    {
      id: BOOK_ID, author_id: USER_ID, title: "Book", status: "published", price_all: null,
      // A legacy value that would say "paid" if anything read it.
      price_cents: 799,
      published_at: "2026-09-01T00:00:00Z", cover_path: "c.png", file_path: "f.epub", language: "sq",
      ...overrides,
    },
    // Two published books of the same author, for bundle membership.
    { id: "book-a", author_id: USER_ID, status: "published", price_all: 0, price_cents: 0 },
    { id: "book-b", author_id: USER_ID, status: "published", price_all: 0, price_cents: 0 },
  ];
}
function seedBundle(overrides: Row) {
  tables.bundles = [
    { id: BUNDLE_ID, author_id: USER_ID, title: "Bundle", status: "published", price_all: null, price_cents: 2500, ...overrides },
  ];
  tables.bundle_books = [
    { bundle_id: BUNDLE_ID, book_id: "book-a" },
    { bundle_id: BUNDLE_ID, book_id: "book-b" },
  ];
}
const book = () => tables.books.find((b) => b.id === BOOK_ID)!;
const bundle = () => tables.bundles.find((b) => b.id === BUNDLE_ID)!;

function bookForm(price: string, extra: Record<string, string | File> = {}): FormData {
  const fd = new FormData();
  fd.set("title", "Book, edited");
  fd.set("description", "New description");
  fd.set("keywords", "");
  fd.set("isbn", "");
  fd.set("genre", "Fiction");
  fd.set("price", price);
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}
function bundleForm(price: string): FormData {
  const fd = new FormData();
  fd.set("title", "Bundle, edited");
  fd.set("description", "Two books");
  fd.set("price", price);
  fd.append("bookIds", "book-a");
  fd.append("bookIds", "book-b");
  return fd;
}

async function redirectOf(action: Promise<unknown>): Promise<string> {
  try {
    await action;
  } catch (error) {
    if (error instanceof RedirectSignal) return error.target;
    throw error;
  }
  return "<no redirect>";
}

function openPaidPublishing() {
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_GIT_COMMIT_REF", "staging");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://erhzpapqwyfjotliqdjo.supabase.co");
  vi.stubEnv("PAID_PUBLISHING_MODE", "controlled_staging_publishing_test");
}

beforeEach(() => {
  vi.unstubAllEnvs();
  tables = {};
  writes = [];
  uploads = [];
  interceptor = null;
  mockRedirect.mockClear();
  seedBook({});
  seedBundle({});
});
afterEach(() => vi.unstubAllEnvs());

// ============================================================
// B. The table, for books, with paid publishing CLOSED.
// ============================================================
describe("updateBook while paid publishing is closed", () => {
  it.each([
    ["published, null -> paid", { status: "published", price_all: null }, "199"],
    ["published, free -> paid", { status: "published", price_all: 0 }, "199"],
    ["published, paid -> different paid", { status: "published", price_all: 199 }, "250"],
  ])("%s is refused with no write of any kind", async (_label, row, price) => {
    seedBook(row);
    const before = { ...book() };

    expect(await redirectOf(updateBook(BOOK_ID, bookForm(price)))).toBe(BOOK_DENIED);

    expect(writes).toEqual([]);
    expect(uploads).toEqual([]);
    expect(book()).toEqual(before);
  });

  it("published, paid -> the SAME paid price allows a metadata-only edit", async () => {
    seedBook({ status: "published", price_all: 199 });

    expect(await redirectOf(updateBook(BOOK_ID, bookForm("199")))).toBe(BOOK_SAVED);
    expect(book()).toMatchObject({ status: "published", price_all: 199, title: "Book, edited" });
  });

  it("published, paid -> free is allowed", async () => {
    seedBook({ status: "published", price_all: 199 });

    expect(await redirectOf(updateBook(BOOK_ID, bookForm("0")))).toBe(BOOK_SAVED);
    expect(book()).toMatchObject({ status: "published", price_all: 0 });
  });

  it("published, free -> free is allowed", async () => {
    seedBook({ status: "published", price_all: 0 });

    expect(await redirectOf(updateBook(BOOK_ID, bookForm("0")))).toBe(BOOK_SAVED);
    expect(book()).toMatchObject({ status: "published", price_all: 0, title: "Book, edited" });
  });

  it("published, null -> free is allowed", async () => {
    seedBook({ status: "published", price_all: null });

    expect(await redirectOf(updateBook(BOOK_ID, bookForm("0")))).toBe(BOOK_SAVED);
    expect(book()).toMatchObject({ status: "published", price_all: 0 });
  });

  it("a draft may save a paid price, and publishing it stays gated", async () => {
    seedBook({ status: "draft", price_all: 0, published_at: null });

    expect(await redirectOf(updateBook(BOOK_ID, bookForm("199")))).toBe(BOOK_SAVED);
    expect(book()).toMatchObject({ status: "draft", price_all: 199 });

    expect(await redirectOf(publishBook(BOOK_ID))).toBe(
      "/dashboard?error=Paid+publishing+isn%27t+available+right+now",
    );
    expect(book()).toMatchObject({ status: "draft", price_all: 199 });
  });

  it("an invalid price keeps its existing validation refusal, at every status", async () => {
    for (const status of ["draft", "published"]) {
      seedBook({ status, price_all: 199 });
      writes = [];
      const target = await redirectOf(updateBook(BOOK_ID, bookForm("98")));
      expect(target).toContain(`/dashboard/books/${BOOK_ID}/edit?error=`);
      expect(target).not.toBe(BOOK_DENIED);
      expect(writes).toEqual([]);
    }
  });

  it("the refusal happens before any cover or manuscript upload", async () => {
    seedBook({ status: "published", price_all: 0 });
    const png = new File(
      [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])],
      "cover.png",
      { type: "image/png" },
    );
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
    const epub = new File([new Uint8Array(await zip.generateAsync({ type: "uint8array" }))], "b.epub", {
      type: "application/epub+zip",
    });

    expect(await redirectOf(updateBook(BOOK_ID, bookForm("199", { cover: png, manuscript: epub })))).toBe(
      BOOK_DENIED,
    );
    expect(uploads).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("the refusal names no environment variable, value, deployment or provider", () => {
    const decoded = decodeURIComponent(BOOK_DENIED);
    for (const leak of ["PAID_", "controlled_staging", "preview", "staging", "POK", "Stripe", "VERCEL"]) {
      expect(decoded).not.toContain(leak);
    }
  });

  it("decides from price_all only: a legacy paid price_cents never makes a free row paid", async () => {
    // price_all 0 (free) with price_cents 799: a free -> free edit. If
    // price_cents were consulted this would look like a paid row.
    seedBook({ status: "published", price_all: 0, price_cents: 799 });
    expect(await redirectOf(updateBook(BOOK_ID, bookForm("0")))).toBe(BOOK_SAVED);
    // And null price_all with a paid price_cents is still "unpriced":
    // same-price reasoning cannot borrow 799 from the legacy column.
    seedBook({ status: "published", price_all: null, price_cents: 199 });
    writes = [];
    expect(await redirectOf(updateBook(BOOK_ID, bookForm("199")))).toBe(BOOK_DENIED);
    expect(writes).toEqual([]);
  });

  it("no update payload ever carries price_cents", async () => {
    seedBook({ status: "published", price_all: 199 });
    await redirectOf(updateBook(BOOK_ID, bookForm("199")));
    const update = writes.find((w) => w.table === "books" && w.op === "update")!;
    expect(update.payload).not.toHaveProperty("price_cents");
  });
});

describe("updateBook while paid publishing is OPEN on protected staging", () => {
  beforeEach(openPaidPublishing);

  it.each([
    ["published, null -> paid", { status: "published", price_all: null }, "199", 199],
    ["published, free -> paid", { status: "published", price_all: 0 }, "199", 199],
    ["published, paid -> different paid", { status: "published", price_all: 199 }, "250", 250],
  ])("%s proceeds normally", async (_label, row, price, stored) => {
    seedBook(row);
    expect(await redirectOf(updateBook(BOOK_ID, bookForm(price)))).toBe(BOOK_SAVED);
    expect(book()).toMatchObject({ status: "published", price_all: stored });
  });
});

// ============================================================
// B. The same table, for bundles.
// ============================================================
describe("updateBundle while paid publishing is closed", () => {
  it.each([
    ["published, null -> paid", { status: "published", price_all: null }, "199"],
    ["published, free -> paid", { status: "published", price_all: 0 }, "199"],
    ["published, paid -> different paid", { status: "published", price_all: 199 }, "250"],
  ])("%s is refused before the bundle update and any membership change", async (_label, row, price) => {
    seedBundle(row);
    const before = { ...bundle() };
    const membersBefore = tables.bundle_books.map((r) => ({ ...r }));

    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm(price)))).toBe(BUNDLE_DENIED);

    expect(writes).toEqual([]);
    expect(bundle()).toEqual(before);
    expect(tables.bundle_books).toEqual(membersBefore);
  });

  it("published, paid -> the SAME paid price allows a metadata-only edit", async () => {
    seedBundle({ status: "published", price_all: 199 });
    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm("199")))).toBe(BUNDLE_SAVED);
    expect(bundle()).toMatchObject({ status: "published", price_all: 199, title: "Bundle, edited" });
  });

  it("published, paid -> free is allowed", async () => {
    seedBundle({ status: "published", price_all: 199 });
    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm("0")))).toBe(BUNDLE_SAVED);
    expect(bundle()).toMatchObject({ status: "published", price_all: 0 });
  });

  it("published, free -> free is allowed", async () => {
    seedBundle({ status: "published", price_all: 0 });
    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm("0")))).toBe(BUNDLE_SAVED);
    expect(bundle()).toMatchObject({ status: "published", price_all: 0 });
  });

  it("a draft may save a paid price, and publishing it stays gated", async () => {
    seedBundle({ status: "draft", price_all: 0 });
    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm("199")))).toBe(BUNDLE_SAVED);
    expect(bundle()).toMatchObject({ status: "draft", price_all: 199 });

    expect(await redirectOf(publishBundle(BUNDLE_ID))).toBe(
      "/dashboard/bundles?error=Paid+publishing+isn%27t+available+right+now",
    );
    expect(bundle()).toMatchObject({ status: "draft", price_all: 199 });
  });

  it("an invalid price keeps its existing validation refusal", async () => {
    seedBundle({ status: "published", price_all: 199 });
    const target = await redirectOf(updateBundle(BUNDLE_ID, bundleForm("98")));
    expect(target).toContain(`/dashboard/bundles/${BUNDLE_ID}/edit?error=`);
    expect(target).not.toBe(BUNDLE_DENIED);
    expect(writes).toEqual([]);
  });

  it("decides from price_all only: a legacy price_cents cannot stand in for a missing price_all", async () => {
    seedBundle({ status: "published", price_all: null, price_cents: 199 });
    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm("199")))).toBe(BUNDLE_DENIED);
    expect(writes).toEqual([]);
  });
});

describe("updateBundle while paid publishing is OPEN on protected staging", () => {
  beforeEach(openPaidPublishing);

  it("published, free -> paid proceeds normally", async () => {
    seedBundle({ status: "published", price_all: 0 });
    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm("199")))).toBe(BUNDLE_SAVED);
    expect(bundle()).toMatchObject({ status: "published", price_all: 199 });
  });
});

// ============================================================
// C. Conditional writes: zero rows is a failure, and the two race
// orderings both fail closed.
// ============================================================
describe("guarded writes report zero rows honestly", () => {
  it("updateBook: a guarded write that matches no row is a controlled failure, not success", async () => {
    seedBook({ status: "draft", price_all: 0 });
    // Between updateBook's read and its write, the row is published
    // (by anything). The draft-only guard then matches nothing.
    interceptor = { table: "books", op: "update", run: async () => void (book().status = "published") };

    expect(await redirectOf(updateBook(BOOK_ID, bookForm("199")))).toBe(BOOK_CHANGED);
    expect(book()).toMatchObject({ status: "published", price_all: 0 });
  });

  it("updateBundle: a refused compare-and-set leaves details and membership untouched", async () => {
    seedBundle({ status: "draft", price_all: 0 });
    const membersBefore = tables.bundle_books.map((r) => ({ ...r }));
    interceptor = { table: "bundles", op: "update", run: async () => void (bundle().status = "published") };

    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm("199")))).toBe(BUNDLE_CHANGED);
    expect(bundle()).toMatchObject({ status: "published", price_all: 0, title: "Bundle" });
    expect(tables.bundle_books).toEqual(membersBefore);
    expect(writes.filter((w) => w.table === "bundle_books")).toEqual([]);
  });

  it("publishBook: a compare-and-set that matches no row is not reported as live", async () => {
    seedBook({ status: "draft", price_all: 0, published_at: null });
    interceptor = { table: "books", op: "update", run: async () => void (book().price_all = 199) };

    const target = await redirectOf(publishBook(BOOK_ID));
    expect(target).not.toContain("success");
    expect(book()).toMatchObject({ status: "draft", price_all: 199 });
  });
});

describe("the publish/update race, books", () => {
  it("price update wins first -> the stale publish fails", async () => {
    // publishBook reads draft + free (0) and decides no paid permission
    // is needed. Before its write lands, a real updateBook makes the
    // draft paid (allowed: it is a draft).
    seedBook({ status: "draft", price_all: 0, published_at: null });
    let concurrent = "";
    interceptor = {
      table: "books",
      op: "update",
      run: async () => {
        concurrent = await redirectOf(updateBook(BOOK_ID, bookForm("199")));
      },
    };

    const target = await redirectOf(publishBook(BOOK_ID));

    expect(concurrent).toBe(BOOK_SAVED);
    expect(target).not.toContain("success");
    // Never a published paid title while paid publishing is closed.
    expect(book()).toMatchObject({ status: "draft", price_all: 199 });
  });

  it("publish wins first -> the stale paid-price update fails", async () => {
    // updateBook reads draft + free and allows a paid price because the
    // row is a draft. Before its write lands, a real publishBook
    // publishes the (still free) draft.
    seedBook({ status: "draft", price_all: 0, published_at: null });
    let concurrent = "";
    interceptor = {
      table: "books",
      op: "update",
      run: async () => {
        concurrent = await redirectOf(publishBook(BOOK_ID));
      },
    };

    const target = await redirectOf(updateBook(BOOK_ID, bookForm("199")));

    expect(concurrent).toBe("/dashboard?success=Your+book+is+now+live");
    expect(target).toBe(BOOK_CHANGED);
    expect(book()).toMatchObject({ status: "published", price_all: 0 });
  });

  it("a stale same-price edit cannot put a paid price back after a concurrent change to free", async () => {
    seedBook({ status: "published", price_all: 199 });
    let concurrent = "";
    interceptor = {
      table: "books",
      op: "update",
      run: async () => {
        concurrent = await redirectOf(updateBook(BOOK_ID, bookForm("0")));
      },
    };

    const target = await redirectOf(updateBook(BOOK_ID, bookForm("199")));

    expect(concurrent).toBe(BOOK_SAVED);
    expect(target).toBe(BOOK_CHANGED);
    expect(book()).toMatchObject({ status: "published", price_all: 0 });
  });
});

describe("the publish/update race, bundles", () => {
  it("price update wins first -> the stale publish fails", async () => {
    seedBundle({ status: "draft", price_all: 0 });
    let concurrent = "";
    interceptor = {
      table: "bundles",
      op: "update",
      run: async () => {
        concurrent = await redirectOf(updateBundle(BUNDLE_ID, bundleForm("199")));
      },
    };

    const target = await redirectOf(publishBundle(BUNDLE_ID));

    expect(concurrent).toBe(BUNDLE_SAVED);
    // publishBundle's zero-row failure redirects to the list page with no
    // success; the row must still be a draft.
    expect(target).toBe("/dashboard/bundles");
    expect(bundle()).toMatchObject({ status: "draft", price_all: 199 });
  });

  it("publish wins first -> the stale paid-price update fails and membership is untouched", async () => {
    seedBundle({ status: "draft", price_all: 0 });
    interceptor = {
      table: "bundles",
      op: "update",
      run: async () => {
        await publishBundle(BUNDLE_ID);
      },
    };

    const target = await redirectOf(updateBundle(BUNDLE_ID, bundleForm("199")));

    expect(target).toBe(BUNDLE_CHANGED);
    expect(bundle()).toMatchObject({ status: "published", price_all: 0, title: "Bundle" });
    expect(writes.filter((w) => w.table === "bundle_books")).toEqual([]);
  });
});

describe("the writes keep their ownership filters", () => {
  it("every books/bundles update is filtered by id and author_id", async () => {
    seedBook({ status: "draft", price_all: 0, published_at: null });
    seedBundle({ status: "draft", price_all: 0 });
    await redirectOf(updateBook(BOOK_ID, bookForm("0")));
    await redirectOf(publishBook(BOOK_ID));
    await redirectOf(updateBundle(BUNDLE_ID, bundleForm("0")));
    await redirectOf(publishBundle(BUNDLE_ID));

    // updateBundle's write is the update_bundle_with_membership RPC,
    // bound to the bundle id and the authenticated author.
    const updates = writes.filter((w) => w.op === "update" || (w.op === "rpc" && w.table === "bundles"));
    expect(updates).toHaveLength(4);
    for (const u of updates) {
      expect(u.filters).toContainEqual({ kind: "eq", column: "author_id", value: USER_ID });
      expect(u.filters.some((f) => f.kind === "eq" && f.column === "id")).toBe(true);
    }
  });

  it("both publish writes compare-and-set on the status and price_all they read", async () => {
    seedBook({ status: "draft", price_all: 0, published_at: null });
    seedBundle({ status: "draft", price_all: 0 });
    await redirectOf(publishBook(BOOK_ID));
    await redirectOf(publishBundle(BUNDLE_ID));

    const [bookPublish, bundlePublish] = writes.filter((w) => w.op === "update");
    for (const w of [bookPublish, bundlePublish]) {
      expect(w.filters).toContainEqual({ kind: "eq", column: "status", value: "draft" });
      expect(w.filters).toContainEqual({ kind: "eq", column: "price_all", value: 0 });
    }
  });
});
