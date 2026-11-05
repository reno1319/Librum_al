import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// PAID-REPRICING-1: the published-repricing gate and the publish/update
// compare-and-set, for bundles (BD15 cleanup: the book half went with
// updateBook/publishBook; saveBookPricing's own are in
// pricing-send.test.ts), driven through the real Server Actions against
// a small in-memory table that applies `.eq()` / `.is()` filters with SQL
// semantics and returns the rows an UPDATE changed.
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
// ADMIN-3-REVIEW: book_reviews reads/writes replaced by a settable
// double (default: nothing pending, approval valid); see
// src/lib/book-reviews-test-double.ts.
vi.mock("@/lib/book-reviews", async (importOriginal) => {
  const { bookReviewsDouble } = await import("@/lib/book-reviews-test-double");
  return bookReviewsDouble(await importOriginal<object>());
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve({ get: () => undefined }) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ __admin: true }) }));
vi.mock("@/lib/email", () => ({ sendNewBookEmails: vi.fn(async () => undefined) }));
// F4 (P4): performPublish now reads the book's rights declaration
// (src/lib/book-rights.ts). This suite is about catalog writes, so the
// declaration is present and recording succeeds; the rights gate itself
// is covered in dashboard/books/f4-rights-pen-name.test.ts.
vi.mock("@/lib/book-rights", () => ({
  getRightsDeclarationState: async () => ({ kind: "present", declaration: { basis: "own_rights" } }),
  recordRightsDeclaration: async () => ({ ok: true }),
}));

type Row = Record<string, unknown>;
type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "is"; column: string; value: null }
  | { kind: "in"; column: string; value: unknown[] }
  // F4 (N1): performPublish's description guard.
  | { kind: "neq"; column: string; value: unknown }
  | { kind: "notNull"; column: string };
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
    // SQL: NULL <> x is not true, so a null column never matches neq.
    if (f.kind === "neq") return row[f.column] != null && row[f.column] !== f.value;
    if (f.kind === "notNull") return row[f.column] != null;
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
    neq: (column: string, value: unknown) => (filters.push({ kind: "neq", column, value }), chain),
    not: (column: string, operator: string, value: unknown) => {
      if (operator !== "is" || value !== null) throw new Error(`unsupported not(${operator})`);
      filters.push({ kind: "notNull", column });
      return chain;
    },
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

const { updateBundle, publishBundle } = await import("./bundles/actions");
const { PAID_REPRICING_UNAVAILABLE_MESSAGE, CATALOG_ROW_CHANGED_MESSAGE } = await import(
  "@/lib/paid-repricing"
);

const BUNDLE_DENIED = `/dashboard/bundles/${BUNDLE_ID}/edit?error=${encodeURIComponent(PAID_REPRICING_UNAVAILABLE_MESSAGE)}`;
const BUNDLE_CHANGED = `/dashboard/bundles/${BUNDLE_ID}/edit?error=${encodeURIComponent(CATALOG_ROW_CHANGED_MESSAGE)}`;
const BUNDLE_SAVED = "/dashboard/bundles?success=Paketa%20u%20p%C3%ABrdit%C3%ABsua";

function seedBook(overrides: Row) {
  tables.books = [
    {
      id: BOOK_ID, author_id: USER_ID, title: "Book", status: "published", price_all: null,
      // A legacy value that would say "paid" if anything read it.
      price_cents: 799,
      published_at: "2026-09-01T00:00:00Z", cover_path: "c.png", file_path: "f.epub", language: "sq",
      description: "A real description.",
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
const bundle = () => tables.bundles.find((b) => b.id === BUNDLE_ID)!;

// LIVE-PRICE-CONFIRM-1: the form carries the live-price tick for the
// price they submit (as an author who ticked it would), so the tables
// below keep testing the paid-repricing rule; the tick rule itself is
// tested on its own further down, with `noTick`.
function bundleForm(price: string): FormData {
  const fd = new FormData();
  fd.set("title", "Bundle, edited");
  fd.set("description", "Two books");
  fd.set("price", price);
  fd.set("confirmPriceChange", price);
  fd.append("bookIds", "book-a");
  fd.append("bookIds", "book-b");
  return fd;
}

function noTick(fd: FormData): FormData {
  fd.delete("confirmPriceChange");
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
describe("the paid-repricing refusal", () => {
  it("names no environment variable, value, deployment or provider", () => {
    const decoded = PAID_REPRICING_UNAVAILABLE_MESSAGE;
    for (const leak of ["PAID_", "controlled_staging", "preview", "staging", "POK", "Stripe", "VERCEL"]) {
      expect(decoded).not.toContain(leak);
    }
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
      "/dashboard/bundles?error=Publikimi%20me%20pages%C3%AB%20nuk%20%C3%ABsht%C3%AB%20i%20mundur%20tani",
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
// LIVE-PRICE-CONFIRM-1 (Renato 10-24, "2. a", "3. a"): a new price on a
// LIVE book or bundle needs the tick carrying exactly that new price.
// ============================================================
const PRICE_CONFIRM = encodeURIComponent("Lexuesit e shohin tashmë këtë çmim, ndaj shënoni kutinë nën çmim për të konfirmuar çmimin e ri.");
const BUNDLE_CONFIRM = `/dashboard/bundles/${BUNDLE_ID}/edit?error=${PRICE_CONFIRM}`;

describe("live price change needs the tick: bundles", () => {
  beforeEach(openPaidPublishing);

  it.each([
    ["paid -> other paid", 199, "299"],
    ["paid -> free", 199, "0"],
  ])("published, %s without the tick: refused, details and books untouched", async (_label, current, price) => {
    seedBundle({ status: "published", price_all: current });
    expect(await redirectOf(updateBundle(BUNDLE_ID, noTick(bundleForm(price))))).toBe(BUNDLE_CONFIRM);
    expect(writes).toEqual([]);
    expect(bundle()).toMatchObject({ title: "Bundle", price_all: current });
  });

  it("a tick for another price does not confirm this one", async () => {
    seedBundle({ status: "published", price_all: 199 });
    const fd = bundleForm("299");
    fd.set("confirmPriceChange", "199");
    expect(await redirectOf(updateBundle(BUNDLE_ID, fd))).toBe(BUNDLE_CONFIRM);
  });

  it("with the tick the new price is saved; a kept price or a draft needs none", async () => {
    seedBundle({ status: "published", price_all: 199 });
    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm("299")))).toBe(BUNDLE_SAVED);
    expect(bundle().price_all).toBe(299);

    seedBundle({ status: "published", price_all: 199 });
    expect(await redirectOf(updateBundle(BUNDLE_ID, noTick(bundleForm("199"))))).toBe(BUNDLE_SAVED);

    seedBundle({ status: "draft", price_all: 199 });
    expect(await redirectOf(updateBundle(BUNDLE_ID, noTick(bundleForm("299"))))).toBe(BUNDLE_SAVED);
  });
});

// ============================================================
// C. Conditional writes: zero rows is a failure, and the two race
// orderings both fail closed.
// ============================================================
describe("guarded writes report zero rows honestly", () => {
  it("updateBundle: a refused compare-and-set leaves details and membership untouched", async () => {
    seedBundle({ status: "draft", price_all: 0 });
    const membersBefore = tables.bundle_books.map((r) => ({ ...r }));
    interceptor = { table: "bundles", op: "update", run: async () => void (bundle().status = "published") };

    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm("199")))).toBe(BUNDLE_CHANGED);
    expect(bundle()).toMatchObject({ status: "published", price_all: 0, title: "Bundle" });
    expect(tables.bundle_books).toEqual(membersBefore);
    expect(writes.filter((w) => w.table === "bundle_books")).toEqual([]);
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
