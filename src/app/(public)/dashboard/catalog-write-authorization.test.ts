import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";

// CATALOG-WRITE-AUTH-1 (Patch 7): which client may write which catalog
// column, driven through the real Server Actions.
//
// Two doubles share one in-memory database:
//
//   * the SESSION client models what an author's own Supabase session is
//     allowed to do: RLS ownership (a row is written only where
//     author_id = the caller) AND, in the "migrated" ACL mode, the exact
//     column grants PARSED FROM the migration file itself. A write naming
//     a column outside those grants fails with 42501, as Postgres does.
//     In the "pre-migration" mode it holds the old table-level grants.
//   * the CATALOG WRITER models the service-role client: no RLS, no
//     column limits. Its only ownership boundary is the filters the
//     action puts on the write, which is exactly what these tests pin.
//
// Every legitimate path must work in BOTH ACL modes (rollout
// compatibility: the new application runs against the old ACL until the
// migration is applied, and against the new ACL after), and no protected
// column may ever be written through the session client.

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
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ __emailAdmin: true }) }));
vi.mock("@/lib/email", () => ({ sendNewBookEmails: vi.fn(async () => undefined) }));

let recoveryActive = false;
vi.mock("@/lib/recovery-guard", () => ({
  redirectIfRecoverySessionActive: vi.fn(async () => {
    if (recoveryActive) mockRedirect("/reset-password");
  }),
}));

// ------------------------------------------------------------
// The ACL, read from the migration -- never restated by hand.
// ------------------------------------------------------------
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const MIGRATION_PATH = path.join(
  REPO_ROOT,
  "supabase/migrations/20260924101853_catalog_write_authorization.sql",
);
const SCHEMA_PATH = path.join(REPO_ROOT, "supabase/schema.sql");

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

type ColumnGrants = Record<"books" | "bundles", { insert: string[]; update: string[] }>;

function parseAuthenticatedColumnGrants(sql: string): ColumnGrants {
  const grants: ColumnGrants = {
    books: { insert: [], update: [] },
    bundles: { insert: [], update: [] },
  };
  const pattern =
    /grant\s+(insert|update)\s*\(([^)]*)\)\s*on\s+(?:table\s+)?public\.(books|bundles)\s+to\s+authenticated\s*;/gi;
  for (const match of stripSqlComments(sql).matchAll(pattern)) {
    const privilege = match[1].toLowerCase() as "insert" | "update";
    const table = match[3].toLowerCase() as "books" | "bundles";
    grants[table][privilege].push(
      ...match[2].split(",").map((c) => c.trim()).filter(Boolean),
    );
  }
  return grants;
}

// Every statement that grants or revokes anything on books/bundles,
// normalised, so the two build paths can be compared statement for
// statement.
function catalogAclStatements(sql: string): string[] {
  const statements = stripSqlComments(sql)
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((s) => /^(grant|revoke)\b/.test(s) && /\bon (table )?public\.(books|bundles)\b/.test(s));
  return statements;
}

const migrationSql = readFileSync(MIGRATION_PATH, "utf8");
const schemaSql = readFileSync(SCHEMA_PATH, "utf8");
const MIGRATED_GRANTS = parseAuthenticatedColumnGrants(migrationSql);

// The columns each legitimate session-client path names. This is the
// inventory the migration's grants must equal -- no more, no less.
const EXPECTED_GRANTS: ColumnGrants = {
  books: {
    insert: [
      "id", "author_id", "title", "subtitle", "description", "keywords", "isbn", "language",
      "publisher", "edition", "original_publication_date", "genre", "series_id",
      "series_position", "price_all", "cover_path", "file_path",
    ],
    update: ["series_id", "series_position"],
  },
  bundles: {
    insert: ["author_id", "title", "description", "price_all"],
    update: [],
  },
};

const PROTECTED_COLUMNS = ["status", "price_all", "published_at", "author_id", "price_cents", "created_at", "updated_at"];

// ------------------------------------------------------------
// The in-memory database and its two clients.
// ------------------------------------------------------------
type Row = Record<string, unknown>;
type Filter =
  | { kind: "eq"; column: string; value: unknown }
  | { kind: "is"; column: string; value: null }
  | { kind: "in"; column: string; value: unknown[] };
type Via = "session" | "catalog-writer";
type Write = {
  via: Via;
  table: string;
  op: "insert" | "update" | "delete";
  payload: unknown;
  filters: Filter[];
  rowsChanged: number;
  denied: boolean;
};
type AclMode = "pre-migration" | "migrated";

const USER_ID = "author-1";
const OTHER_AUTHOR = "author-2";
const BOOK_ID = "book-1";
const BUNDLE_ID = "bundle-1";
const SERIES_ID = "series-1";

let tables: Record<string, Row[]> = {};
let writes: Write[] = [];
let events: string[] = [];
let aclMode: AclMode = "migrated";
// Forces the NEXT catalog-writer update to report this many rows, to
// model a zero-row or multi-row result without touching the rows.
let forcedCatalogWriterRowCount: number | null = null;

const OWNED_TABLES = new Set(["books", "bundles"]);
const INSERT_DEFAULTS: Record<string, Row> = {
  books: { status: "draft", price_cents: 0, published_at: null, preview_text: "" },
  bundles: { status: "draft", price_cents: 0 },
};

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    if (f.kind === "eq") return f.value !== null && row[f.column] === f.value;
    if (f.kind === "is") return row[f.column] === null;
    return f.value.includes(row[f.column]);
  });
}

function sessionMayWrite(table: string, op: "insert" | "update", keys: string[]): boolean {
  if (aclMode === "pre-migration" || !OWNED_TABLES.has(table)) return true;
  const granted = MIGRATED_GRANTS[table as "books" | "bundles"][op];
  return keys.every((k) => granted.includes(k));
}

function sessionRlsVisible(table: string, row: Row): boolean {
  if (!OWNED_TABLES.has(table)) return true;
  return row.status === "published" || row.author_id === USER_ID;
}

function builder(table: string, via: Via) {
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: unknown;
  let columns = "*";
  let returning = false;
  let single: "single" | "maybe" | null = null;
  const filters: Filter[] = [];

  async function execute() {
    const rows = (tables[table] ??= []);
    const rlsScoped = (r: Row) =>
      via === "catalog-writer" || !OWNED_TABLES.has(table) || r.author_id === USER_ID;

    if (op === "select") {
      let data: Row[] = rows
        .filter((r) => (via === "session" ? sessionRlsVisible(table, r) : true))
        .filter((r) => matches(r, filters))
        .map((r) => ({ ...r }));
      if (table === "bundle_books" && columns.includes("books(")) {
        data = data.map((r) => ({ ...r, books: tables.books.find((b) => b.id === r.book_id) ?? null }));
      }
      if (table === "bundle_books" && columns.includes("bundles!inner")) {
        const statusFilter = filters.find((f) => f.column === "bundles.status");
        data = rows
          .filter((r) => r.book_id === filters.find((f) => f.column === "book_id")?.value)
          .filter((r) => {
            const b = tables.bundles.find((x) => x.id === r.bundle_id);
            return !!b && (!statusFilter || b.status === statusFilter.value);
          });
      }
      if (single === "single") {
        return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { code: "PGRST116" } };
      }
      if (single === "maybe") return { data: data[0] ?? null, error: null };
      return { data, error: null };
    }

    if (op === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload]) as Row[];
      const keys = [...new Set(list.flatMap((r) => Object.keys(r)))];
      const denied =
        via === "session" &&
        (!sessionMayWrite(table, "insert", keys) ||
          (OWNED_TABLES.has(table) && list.some((r) => r.author_id !== USER_ID)));
      if (denied) {
        writes.push({ via, table, op, payload, filters: [], rowsChanged: 0, denied: true });
        return { data: null, error: { code: "42501", message: "permission denied" } };
      }
      const inserted = list.map((r) => ({
        ...(INSERT_DEFAULTS[table] ?? {}),
        id: r.id ?? `${table}-new-${rows.length + 1}`,
        ...r,
      }));
      rows.push(...inserted);
      writes.push({ via, table, op, payload, filters: [], rowsChanged: inserted.length, denied: false });
      const returned = inserted.map((r) => ({ id: r.id }));
      if (!returning) return { data: null, error: null };
      if (single) return { data: returned[0] ?? null, error: null };
      return { data: returned, error: null };
    }

    if (op === "delete") {
      const doomed = rows.filter((r) => rlsScoped(r) && matches(r, filters));
      tables[table] = rows.filter((r) => !doomed.includes(r));
      writes.push({ via, table, op, payload: undefined, filters: [...filters], rowsChanged: doomed.length, denied: false });
      return { data: null, error: null };
    }

    // update
    const keys = Object.keys(payload as Row);
    if (via === "session" && !sessionMayWrite(table, "update", keys)) {
      writes.push({ via, table, op, payload, filters: [...filters], rowsChanged: 0, denied: true });
      return { data: null, error: { code: "42501", message: "permission denied" } };
    }
    const changed = rows.filter((r) => rlsScoped(r) && matches(r, filters));
    if (via === "catalog-writer" && forcedCatalogWriterRowCount !== null) {
      const count = forcedCatalogWriterRowCount;
      forcedCatalogWriterRowCount = null;
      writes.push({ via, table, op, payload, filters: [...filters], rowsChanged: count, denied: false });
      return { data: Array.from({ length: count }, (_, i) => ({ id: `row-${i}` })), error: null };
    }
    for (const r of changed) Object.assign(r, payload as Row);
    writes.push({ via, table, op, payload, filters: [...filters], rowsChanged: changed.length, denied: false });
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

let signedIn = true;
const sessionClient = {
  auth: {
    getUser: async () => {
      events.push("session:getUser");
      return { data: { user: signedIn ? { id: USER_ID } : null } };
    },
  },
  from: (table: string) => builder(table, "session"),
  storage: {
    from: (bucket: string) => ({
      upload: async (p: string) => (events.push(`upload:${bucket}:${p}`), { error: null }),
      remove: async () => ({ error: null }),
      download: async () => ({ data: null, error: { message: "not used" } }),
    }),
  },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => sessionClient }));

const catalogWriter = { from: (table: string) => builder(table, "catalog-writer") };
const mockCreateCatalogWriteClient = vi.fn(() => {
  events.push("createCatalogWriteClient");
  return catalogWriter;
});
vi.mock("@/lib/catalog-write-client", () => ({
  createCatalogWriteClient: () => mockCreateCatalogWriteClient(),
}));

const { createBook, updateBook, publishBook, unpublishBook } = await import("./books/actions");
const { createBundle, updateBundle, publishBundle, unpublishBundle } = await import("./bundles/actions");
const { deleteSeries } = await import("./series/actions");
// The one value resolveMaintenanceMode() treats as active (not exported
// by src/lib/maintenance-mode.ts; pinned by maintenance-mode.test.ts).
const MAINTENANCE_ACTIVE_VALUE = "active";
const maintenance = () => vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", MAINTENANCE_ACTIVE_VALUE);

// ------------------------------------------------------------
// Fixtures.
// ------------------------------------------------------------
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);

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

async function createBookForm(price: string, intent?: "publish"): Promise<FormData> {
  const fd = new FormData();
  fd.set("title", "New book");
  fd.set("description", "A description.");
  fd.set("keywords", "");
  fd.set("isbn", "");
  fd.set("genre", "Fiction");
  fd.set("price", price);
  fd.set("cover", new File([new Uint8Array(PNG_SIGNATURE)], "cover.png", { type: "image/png" }));
  fd.set(
    "manuscript",
    new File([new Uint8Array(await validEpub())], "book.epub", { type: "application/epub+zip" }),
  );
  if (intent) fd.set("intent", intent);
  return fd;
}

function editBookForm(price: string): FormData {
  const fd = new FormData();
  fd.set("title", "Book, edited");
  fd.set("description", "New description");
  fd.set("keywords", "");
  fd.set("isbn", "");
  fd.set("genre", "Fiction");
  fd.set("price", price);
  return fd;
}

function bundleForm(price: string, title = "Bundle, edited"): FormData {
  const fd = new FormData();
  fd.set("title", title);
  fd.set("description", "Two books");
  fd.set("price", price);
  fd.append("bookIds", "book-a");
  fd.append("bookIds", "book-b");
  return fd;
}

function seed(overrides: { book?: Row; bundle?: Row } = {}) {
  tables.books = [
    {
      id: BOOK_ID, author_id: USER_ID, title: "Book", status: "draft", price_all: 0, price_cents: 0,
      published_at: null, cover_path: "c.png", file_path: "f.epub", language: "sq",
      series_id: SERIES_ID, series_position: 2, ...overrides.book,
    },
    { id: "book-a", author_id: USER_ID, status: "published", price_all: 0, price_cents: 0, series_id: SERIES_ID, series_position: 1 },
    { id: "book-b", author_id: USER_ID, status: "published", price_all: 0, price_cents: 0, series_id: null, series_position: null },
    { id: "book-other", author_id: OTHER_AUTHOR, status: "draft", price_all: 0, price_cents: 0, series_id: SERIES_ID, series_position: 1 },
  ];
  tables.bundles = [
    { id: BUNDLE_ID, author_id: USER_ID, title: "Bundle", description: "", status: "draft", price_all: 0, price_cents: 0, ...overrides.bundle },
    { id: "bundle-other", author_id: OTHER_AUTHOR, title: "Other", status: "published", price_all: 0, price_cents: 0 },
  ];
  tables.bundle_books = [
    { bundle_id: BUNDLE_ID, book_id: "book-a" },
    { bundle_id: BUNDLE_ID, book_id: "book-b" },
  ];
  tables.series = [{ id: SERIES_ID, author_id: USER_ID, title: "Series" }];
}

const bookRow = (id = BOOK_ID) => tables.books.find((b) => b.id === id)!;
const bundleRow = (id = BUNDLE_ID) => tables.bundles.find((b) => b.id === id)!;

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

const catalogWrites = () => writes.filter((w) => w.via === "catalog-writer");
const sessionWritesTo = (table: string) =>
  writes.filter((w) => w.via === "session" && w.table === table);
const writtenKeys = (w: Write) =>
  (Array.isArray(w.payload) ? (w.payload as Row[]) : [w.payload as Row]).flatMap((r) => Object.keys(r ?? {}));

beforeEach(() => {
  vi.unstubAllEnvs();
  tables = {};
  writes = [];
  events = [];
  aclMode = "migrated";
  signedIn = true;
  recoveryActive = false;
  forcedCatalogWriterRowCount = null;
  mockRedirect.mockClear();
  mockCreateCatalogWriteClient.mockClear();
  seed();
});
afterEach(() => vi.unstubAllEnvs());

// ============================================================
// 1. The ACL itself: migration and schema.sql, read as text.
// ============================================================
describe("the migration's grants are exactly the inventoried columns", () => {
  it("authenticated INSERT/UPDATE column grants equal the application inventory", () => {
    for (const table of ["books", "bundles"] as const) {
      expect([...MIGRATED_GRANTS[table].insert].sort()).toEqual([...EXPECTED_GRANTS[table].insert].sort());
      expect([...MIGRATED_GRANTS[table].update].sort()).toEqual([...EXPECTED_GRANTS[table].update].sort());
    }
  });

  it("status is never insertable, and no protected column is ever updatable, on either table", () => {
    for (const sql of [migrationSql, schemaSql]) {
      const grants = parseAuthenticatedColumnGrants(sql);
      for (const table of ["books", "bundles"] as const) {
        expect(grants[table].insert).not.toContain("status");
        expect(grants[table].insert).not.toContain("price_cents");
        expect(grants[table].insert).not.toContain("published_at");
        expect(grants[table].insert).not.toContain("created_at");
        expect(grants[table].insert).not.toContain("updated_at");
        for (const column of PROTECTED_COLUMNS) {
          expect(grants[table].update).not.toContain(column);
        }
      }
    }
  });

  it("table-level grants are exactly SELECT to anon and SELECT, DELETE to authenticated", () => {
    for (const sql of [migrationSql, schemaSql]) {
      const statements = catalogAclStatements(sql);
      for (const table of ["books", "bundles"]) {
        const tableLevelGrants = statements.filter(
          (s) =>
            s.startsWith("grant") &&
            !s.slice(0, s.indexOf(" on ")).includes("(") &&
            s.includes(` on public.${table} `),
        );
        expect(tableLevelGrants).toEqual([
          `grant select on public.${table} to anon`,
          `grant select, delete on public.${table} to authenticated`,
        ]);
      }
      for (const statement of statements) {
        if (!statement.startsWith("grant")) continue;
        const privileges = statement.slice("grant".length, statement.indexOf(" on ")).trim();
        const tableLevel = !privileges.includes("(");
        if (tableLevel) {
          // Neither DML writes nor the non-DML capabilities the reset
          // removes: TRUNCATE, REFERENCES, TRIGGER, MAINTAIN.
          expect(privileges).not.toMatch(
            /\b(insert|update|all|truncate|references|trigger|maintain)\b/,
          );
        } else {
          // Column grants go to authenticated only, and never REFERENCES.
          expect(statement).toMatch(/ to authenticated$/);
          expect(privileges).not.toMatch(/\breferences\b/);
        }
        expect(statement).not.toMatch(/\bto public\b/);
        if (/\bto anon\b/.test(statement)) {
          expect(privileges).toBe("select");
        }
      }
    }
  });

  it("resets every PUBLIC, anon and authenticated privilege before any grant on the table", () => {
    for (const sql of [migrationSql, schemaSql]) {
      const statements = catalogAclStatements(sql);
      for (const table of ["books", "bundles"]) {
        const onTable = statements.filter((s) => s.includes(` on public.${table} `) || s.endsWith(` on public.${table}`));
        expect(onTable[0]).toBe(`revoke all on public.${table} from public, anon, authenticated`);
        // The reset is the only revoke: nothing is revoked after a grant,
        // and no narrower, partial revoke is left over.
        expect(onTable.filter((s) => s.startsWith("revoke"))).toEqual([
          `revoke all on public.${table} from public, anon, authenticated`,
        ]);
      }
    }
  });

  it("schema.sql issues the identical ACL statements as the migration, in the same order", () => {
    expect(catalogAclStatements(schemaSql)).toEqual(catalogAclStatements(migrationSql));
  });

  it("the migration issues no DML, no trigger, no function and no policy change", () => {
    const body = stripSqlComments(migrationSql).toLowerCase();
    expect(body).not.toMatch(/\b(insert into|update public|delete from|truncate public)\b/);
    expect(body).not.toMatch(/\bcreate\b|\balter\b|\bdrop\b|security definer/);
  });

  it("the status default stays exactly 'draft' in schema.sql, on both tables", () => {
    const status = schemaSql.match(/status text not null default '([a-z]+)' check \(status in \('draft', 'published'\)\)/g);
    expect(status).toHaveLength(2);
    for (const declaration of status!) expect(declaration).toContain("default 'draft'");
  });
});

// ============================================================
// 2. Every legitimate path works under BOTH ACLs, and never writes a
//    protected column through the session client.
// ============================================================
describe.each<AclMode>(["pre-migration", "migrated"])("rollout compatibility: %s ACL", (mode) => {
  beforeEach(() => {
    aclMode = mode;
  });

  it("createBook: a PAID draft is created on the session, taking status from the default", async () => {
    tables.books = [];
    expect(await redirectOf(createBook(await createBookForm("199")))).toBe("/dashboard");

    const [insert] = sessionWritesTo("books");
    expect(insert).toMatchObject({ op: "insert", denied: false, rowsChanged: 1 });
    expect(insert.payload).not.toHaveProperty("status");
    expect(insert.payload).toMatchObject({ author_id: USER_ID, price_all: 199 });
    expect(tables.books).toHaveLength(1);
    expect(tables.books[0]).toMatchObject({ status: "draft", price_all: 199, published_at: null });
    expect(mockCreateCatalogWriteClient).not.toHaveBeenCalled();
  });

  it("createBundle: a PAID draft bundle is created on the session", async () => {
    tables.bundles = [];
    expect(await redirectOf(createBundle(bundleForm("299", "New bundle")))).toBe(
      "/dashboard/bundles?success=Bundle+created+as+a+draft",
    );
    const [insert] = sessionWritesTo("bundles");
    expect(insert).toMatchObject({ op: "insert", denied: false, rowsChanged: 1 });
    expect(insert.payload).not.toHaveProperty("status");
    expect(tables.bundles[0]).toMatchObject({ status: "draft", price_all: 299 });
    expect(mockCreateCatalogWriteClient).not.toHaveBeenCalled();
  });

  it("createBook intent=publish (free): inserted on the session, published by the catalog writer", async () => {
    tables.books = [];
    expect(await redirectOf(createBook(await createBookForm("0", "publish")))).toBe(
      "/dashboard?success=Your+book+is+now+live",
    );
    expect(tables.books[0]).toMatchObject({ status: "published", price_all: 0 });
    expect(tables.books[0].published_at).toEqual(expect.any(String));
    expect(catalogWrites()).toHaveLength(1);
    expect(catalogWrites()[0].payload).toMatchObject({ status: "published" });
  });

  it("updateBook: one atomic catalog-writer update carries metadata AND price_all", async () => {
    expect(await redirectOf(updateBook(BOOK_ID, editBookForm("199")))).toBe("/dashboard?success=Book+updated");
    expect(bookRow()).toMatchObject({ title: "Book, edited", price_all: 199, status: "draft" });

    const bookUpdates = writes.filter((w) => w.table === "books" && w.op === "update");
    expect(bookUpdates).toHaveLength(1);
    expect(bookUpdates[0].via).toBe("catalog-writer");
    expect(bookUpdates[0].payload).toMatchObject({ title: "Book, edited", description: "New description", price_all: 199 });
  });

  it("updateBook on a published paid book, same price: metadata edit succeeds", async () => {
    seed({ book: { status: "published", price_all: 199, published_at: "2026-09-01T00:00:00Z" } });
    expect(await redirectOf(updateBook(BOOK_ID, editBookForm("199")))).toBe("/dashboard?success=Book+updated");
    expect(bookRow()).toMatchObject({ title: "Book, edited", price_all: 199, status: "published" });
  });

  it("publishBook: the catalog writer sets status and first published_at", async () => {
    expect(await redirectOf(publishBook(BOOK_ID))).toBe("/dashboard?success=Your+book+is+now+live");
    expect(bookRow()).toMatchObject({ status: "published" });
    expect(bookRow().published_at).toEqual(expect.any(String));
    expect(catalogWrites()).toHaveLength(1);
  });

  it("publishBook on a republish keeps the original published_at", async () => {
    seed({ book: { status: "draft", price_all: 0, published_at: "2026-01-01T00:00:00Z" } });
    expect(await redirectOf(publishBook(BOOK_ID))).toBe("/dashboard?success=Your+book+is+now+live");
    expect(bookRow().published_at).toBe("2026-01-01T00:00:00Z");
    expect(catalogWrites()[0].payload).not.toHaveProperty("published_at");
  });

  it("publishBook: a paid draft publishes when paid publishing is open", async () => {
    openPaidPublishing();
    seed({ book: { status: "draft", price_all: 199 } });
    expect(await redirectOf(publishBook(BOOK_ID))).toBe("/dashboard?success=Your+book+is+now+live");
    expect(bookRow()).toMatchObject({ status: "published", price_all: 199 });
  });

  it("unpublishBook: the catalog writer returns the book to draft", async () => {
    seed({ book: { status: "published", price_all: 0, published_at: "2026-09-01T00:00:00Z" } });
    await unpublishBook(BOOK_ID);
    expect(bookRow()).toMatchObject({ status: "draft", published_at: "2026-09-01T00:00:00Z" });
    expect(catalogWrites()).toHaveLength(1);
  });

  it("updateBundle: one atomic catalog-writer update, then membership on the session", async () => {
    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm("299")))).toBe(
      "/dashboard/bundles?success=Bundle+updated",
    );
    expect(bundleRow()).toMatchObject({ title: "Bundle, edited", price_all: 299, status: "draft" });
    const bundleUpdates = writes.filter((w) => w.table === "bundles" && w.op === "update");
    expect(bundleUpdates).toHaveLength(1);
    expect(bundleUpdates[0].via).toBe("catalog-writer");
    expect(bundleUpdates[0].payload).toEqual({ title: "Bundle, edited", description: "Two books", price_all: 299 });
    const membershipWrites = writes.filter((w) => w.table === "bundle_books");
    expect(membershipWrites.map((w) => [w.via, w.op])).toEqual([
      ["session", "delete"],
      ["session", "insert"],
    ]);
  });

  it("publishBundle and unpublishBundle go through the catalog writer", async () => {
    await publishBundle(BUNDLE_ID);
    expect(bundleRow().status).toBe("published");
    await unpublishBundle(BUNDLE_ID);
    expect(bundleRow().status).toBe("draft");
    expect(catalogWrites().map((w) => w.payload)).toEqual([{ status: "published" }, { status: "draft" }]);
  });

  it("deleteSeries: the series unlink stays on the session and works", async () => {
    await deleteSeries(SERIES_ID);
    const unlink = sessionWritesTo("books").find((w) => w.op === "update")!;
    expect(unlink).toMatchObject({ denied: false });
    expect(unlink.payload).toEqual({ series_id: null, series_position: null });
    expect(bookRow()).toMatchObject({ series_id: null, series_position: null });
    expect(bookRow("book-a")).toMatchObject({ series_id: null, series_position: null });
    // Another author's book in the same series is untouched (RLS + filter).
    expect(bookRow("book-other")).toMatchObject({ series_id: SERIES_ID, series_position: 1 });
    expect(mockCreateCatalogWriteClient).not.toHaveBeenCalled();
  });

  it("no action ever writes a protected column of books or bundles through the session client", async () => {
    openPaidPublishing();
    tables.books.push({ id: "book-new-x", author_id: USER_ID, status: "draft", price_all: 0 });
    await redirectOf(createBook(await createBookForm("199", "publish")));
    await redirectOf(updateBook(BOOK_ID, editBookForm("250")));
    await redirectOf(publishBook(BOOK_ID));
    await unpublishBook(BOOK_ID);
    await redirectOf(updateBundle(BUNDLE_ID, bundleForm("299")));
    await redirectOf(publishBundle(BUNDLE_ID));
    await unpublishBundle(BUNDLE_ID);
    await deleteSeries(SERIES_ID);

    for (const w of writes) {
      expect(w.denied).toBe(false);
      if (w.via !== "session" || !OWNED_TABLES.has(w.table)) continue;
      if (w.op === "update") {
        for (const key of writtenKeys(w)) expect(["series_id", "series_position"]).toContain(key);
      }
      if (w.op === "insert") expect(writtenKeys(w)).not.toContain("status");
    }
  });
});

// ============================================================
// 3. The migrated ACL really refuses what it must (the double's
//    enforcement is not vacuous).
// ============================================================
type DirectWrite = PromiseLike<{ error: { code: string } | null }> & {
  update(payload: unknown): DirectWrite;
  insert(payload: unknown): DirectWrite;
  eq(column: string, value: unknown): DirectWrite;
};
const direct = (table: string) => sessionClient.from(table) as unknown as DirectWrite;

describe("the migrated session double enforces the parsed grants", () => {
  it.each([
    ["books", { status: "published" }],
    ["books", { price_all: 500 }],
    ["books", { published_at: "2026-09-24T00:00:00Z" }],
    ["books", { author_id: OTHER_AUTHOR }],
    ["books", { price_cents: 100 }],
    ["books", { title: "direct" }],
    ["bundles", { status: "published" }],
    ["bundles", { price_all: 500 }],
    ["bundles", { title: "direct" }],
  ])("session UPDATE on %s %j is denied", async (table, payload) => {
    const result = await direct(table).update(payload).eq("id", table === "books" ? BOOK_ID : BUNDLE_ID);
    expect(result.error?.code).toBe("42501");
  });

  it.each([
    ["books", { id: "x1", author_id: USER_ID, title: "t", status: "published", price_all: 500 }],
    ["books", { id: "x2", author_id: USER_ID, title: "t", status: "draft" }],
    ["bundles", { author_id: USER_ID, title: "t", status: "published" }],
    ["bundles", { author_id: USER_ID, title: "t", status: "draft" }],
  ])("session INSERT into %s naming status is denied: %j", async (table, payload) => {
    const result = await direct(table).insert(payload);
    expect(result.error?.code).toBe("42501");
  });
});

// ============================================================
// 4. Privileged authority is created only after authentication and
//    only once every rejecting gate has passed.
// ============================================================
describe("the catalog writer is never created on a refused request", () => {
  const refusals: Array<[string, () => void, () => Promise<unknown>]> = [
    ["updateBook: signed out", () => (signedIn = false), () => updateBook(BOOK_ID, editBookForm("199"))],
    ["updateBook: maintenance", maintenance, () => updateBook(BOOK_ID, editBookForm("199"))],
    ["publishBook: maintenance", maintenance, () => publishBook(BOOK_ID)],
    ["unpublishBook: maintenance", maintenance, () => unpublishBook(BOOK_ID)],
    ["updateBundle: maintenance", maintenance, () => updateBundle(BUNDLE_ID, bundleForm("299"))],
    ["publishBundle: maintenance", maintenance, () => publishBundle(BUNDLE_ID)],
    ["unpublishBundle: maintenance", maintenance, () => unpublishBundle(BUNDLE_ID)],
    ["updateBook: another author's book", () => undefined, () => updateBook("book-other", editBookForm("199"))],
    ["updateBook: invalid price", () => undefined, () => updateBook(BOOK_ID, editBookForm("5"))],
    ["updateBook: repricing refused", () => seed({ book: { status: "published", price_all: 0 } }), () => updateBook(BOOK_ID, editBookForm("199"))],
    ["publishBook: signed out", () => (signedIn = false), () => publishBook(BOOK_ID)],
    ["publishBook: recovery session", () => (recoveryActive = true), () => publishBook(BOOK_ID)],
    ["publishBook: another author's book", () => undefined, () => publishBook("book-other")],
    ["publishBook: paid while paid publishing is closed", () => seed({ book: { price_all: 199 } }), () => publishBook(BOOK_ID)],
    ["publishBook: missing price", () => seed({ book: { price_all: null } }), () => publishBook(BOOK_ID)],
    ["unpublishBook: recovery session", () => (recoveryActive = true), () => unpublishBook(BOOK_ID)],
    ["unpublishBook: in a published bundle", () => seed({ book: { id: "book-x" }, bundle: { status: "published" } }), () => unpublishBook("book-a")],
    ["unpublishBook: another author's book", () => undefined, () => unpublishBook("book-other")],
    ["updateBundle: signed out", () => (signedIn = false), () => updateBundle(BUNDLE_ID, bundleForm("299"))],
    ["updateBundle: another author's bundle", () => undefined, () => updateBundle("bundle-other", bundleForm("299"))],
    ["updateBundle: repricing refused", () => seed({ bundle: { status: "published", price_all: 0 } }), () => updateBundle(BUNDLE_ID, bundleForm("299"))],
    ["updateBundle: invalid selection", () => (tables.books = tables.books.filter((b) => b.id !== "book-b")), () => updateBundle(BUNDLE_ID, bundleForm("299"))],
    ["publishBundle: paid while closed", () => seed({ bundle: { price_all: 299 } }), () => publishBundle(BUNDLE_ID)],
    ["publishBundle: insufficient members", () => (tables.bundle_books = tables.bundle_books.slice(0, 1)), () => publishBundle(BUNDLE_ID)],
    ["publishBundle: recovery session", () => (recoveryActive = true), () => publishBundle(BUNDLE_ID)],
    ["unpublishBundle: signed out", () => (signedIn = false), () => unpublishBundle(BUNDLE_ID)],
    ["unpublishBundle: recovery session", () => (recoveryActive = true), () => unpublishBundle(BUNDLE_ID)],
  ];

  it.each(refusals)("%s", async (_label, arrange, act) => {
    arrange();
    // A refusal may redirect or (unpublishBundle under maintenance) throw.
    await act().catch(() => undefined);
    expect(mockCreateCatalogWriteClient).not.toHaveBeenCalled();
    expect(catalogWrites()).toEqual([]);
  });

  it.each<[string, () => Promise<unknown>]>([
    ["updateBook", () => updateBook(BOOK_ID, editBookForm("199"))],
    ["publishBook", () => publishBook(BOOK_ID)],
    ["unpublishBook", () => unpublishBook(BOOK_ID)],
    ["updateBundle", () => updateBundle(BUNDLE_ID, bundleForm("299"))],
    ["publishBundle", () => publishBundle(BUNDLE_ID)],
    ["unpublishBundle", () => unpublishBundle(BUNDLE_ID)],
  ])("%s authenticates on the session before creating the catalog writer, and writes once", async (_label, act) => {
    await redirectOf(act());
    const auth = events.indexOf("session:getUser");
    const created = events.indexOf("createCatalogWriteClient");
    expect(auth).toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThan(auth);
    expect(events.filter((e) => e === "createCatalogWriteClient")).toHaveLength(1);
    // Every upload the action makes happens before privileged authority exists.
    for (const [i, e] of events.entries()) if (e.startsWith("upload:")) expect(i).toBeLessThan(created);
  });
});

// ============================================================
// 5. Every privileged write is scoped by id AND author_id, keeps the
//    Patch 6 compare-and-set, and proves exactly one row.
// ============================================================
describe("privileged writes stay narrow", () => {
  it("every catalog-writer write filters by the row id and the caller's author_id", async () => {
    openPaidPublishing();
    await redirectOf(updateBook(BOOK_ID, editBookForm("199")));
    await redirectOf(publishBook(BOOK_ID));
    await unpublishBook(BOOK_ID);
    await redirectOf(updateBundle(BUNDLE_ID, bundleForm("299")));
    await redirectOf(publishBundle(BUNDLE_ID));
    await unpublishBundle(BUNDLE_ID);

    expect(catalogWrites()).toHaveLength(6);
    for (const w of catalogWrites()) {
      const id = w.table === "books" ? BOOK_ID : BUNDLE_ID;
      expect(w.filters).toContainEqual({ kind: "eq", column: "id", value: id });
      expect(w.filters).toContainEqual({ kind: "eq", column: "author_id", value: USER_ID });
      expect(w.op).toBe("update");
    }
  });

  it("the publish writes compare-and-set on BOTH the status and price_all they read", async () => {
    seed({ book: { price_all: 0 }, bundle: { price_all: 0 } });
    await redirectOf(publishBook(BOOK_ID));
    await redirectOf(publishBundle(BUNDLE_ID));
    for (const w of catalogWrites()) {
      expect(w.filters).toContainEqual({ kind: "eq", column: "status", value: "draft" });
      expect(w.filters).toContainEqual({ kind: "eq", column: "price_all", value: 0 });
    }
  });

  it("a same-price edit of a published paid title compare-and-sets on status and price_all", async () => {
    seed({ book: { status: "published", price_all: 199 }, bundle: { status: "published", price_all: 299 } });
    await redirectOf(updateBook(BOOK_ID, editBookForm("199")));
    await redirectOf(updateBundle(BUNDLE_ID, bundleForm("299")));
    for (const w of catalogWrites()) {
      expect(w.filters).toContainEqual({ kind: "eq", column: "status", value: "published" });
      expect(w.filters).toContainEqual({ kind: "eq", column: "price_all", value: w.table === "books" ? 199 : 299 });
    }
  });

  it("the privileged write cannot touch another author's row even though it bypasses RLS", async () => {
    // The ownership read fails first, so no write exists at all; and a
    // write that did run could not match: author_id is in its filter.
    await redirectOf(publishBook("book-other"));
    await redirectOf(updateBundle("bundle-other", bundleForm("0")));
    expect(bookRow("book-other")).toMatchObject({ status: "draft" });
    expect(bundleRow("bundle-other")).toMatchObject({ title: "Other" });
    expect(catalogWrites()).toEqual([]);
  });

  it.each([0, 2])("updateBook: a %i-row result fails closed", async (count) => {
    forcedCatalogWriterRowCount = count;
    expect(await redirectOf(updateBook(BOOK_ID, editBookForm("199")))).toMatch(
      new RegExp(`^/dashboard/books/${BOOK_ID}/edit\\?error=`),
    );
  });

  it.each([0, 2])("publishBook: a %i-row result is not reported as live", async (count) => {
    forcedCatalogWriterRowCount = count;
    expect(await redirectOf(publishBook(BOOK_ID))).toBe("/dashboard");
  });

  it.each([0, 2])("unpublishBook: a %i-row result fails closed", async (count) => {
    seed({ book: { status: "published" } });
    forcedCatalogWriterRowCount = count;
    expect(await redirectOf(unpublishBook(BOOK_ID))).toBe("/dashboard?error=Could+not+unpublish+that+book+right+now");
  });

  it.each([0, 2])("updateBundle: a %i-row result fails closed and leaves membership untouched", async (count) => {
    const membersBefore = tables.bundle_books.map((r) => ({ ...r }));
    forcedCatalogWriterRowCount = count;
    expect(await redirectOf(updateBundle(BUNDLE_ID, bundleForm("299")))).toMatch(
      new RegExp(`^/dashboard/bundles/${BUNDLE_ID}/edit\\?error=`),
    );
    expect(tables.bundle_books).toEqual(membersBefore);
    expect(writes.filter((w) => w.table === "bundle_books")).toEqual([]);
  });

  it.each([0, 2])("publishBundle: a %i-row result is not reported as published", async (count) => {
    forcedCatalogWriterRowCount = count;
    expect(await redirectOf(publishBundle(BUNDLE_ID))).toBe("/dashboard/bundles");
  });

  it.each([0, 2])("unpublishBundle: a %i-row result fails closed", async (count) => {
    seed({ bundle: { status: "published" } });
    forcedCatalogWriterRowCount = count;
    expect(await redirectOf(unpublishBundle(BUNDLE_ID))).toMatch(/^\/dashboard\/bundles\?error=/);
  });
});

// ============================================================
// 6. The privileged client can never reach browser code.
// ============================================================
describe("the privileged client stays server-only", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
    });
  }

  it("catalog-write-client imports server-only and nothing but the admin factory", () => {
    const source = readFileSync(path.join(REPO_ROOT, "src/lib/catalog-write-client.ts"), "utf8");
    expect(source).toMatch(/^import "server-only";/);
    expect(source.match(/^import .*$/gm)).toEqual([
      'import "server-only";',
      'import { createAdminClient } from "@/lib/supabase/admin";',
    ]);
  });

  it("no client component imports the catalog writer or the admin client", () => {
    const offenders = sourceFiles(path.join(REPO_ROOT, "src")).filter((file) => {
      const source = readFileSync(file, "utf8");
      const isClientModule = /^\s*["']use client["']/.test(source);
      return (
        isClientModule &&
        /from\s+["']@\/lib\/(catalog-write-client|supabase\/admin)["']/.test(source)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("the catalog writer is used only by the two dashboard action modules", () => {
    const users = sourceFiles(path.join(REPO_ROOT, "src"))
      .filter((file) => /from\s+["']@\/lib\/catalog-write-client["']/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(REPO_ROOT, file))
      .sort();
    expect(users).toEqual([
      "src/app/(public)/dashboard/books/actions.ts",
      "src/app/(public)/dashboard/bundles/actions.ts",
    ]);
  });
});
