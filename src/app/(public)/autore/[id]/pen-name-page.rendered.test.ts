import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// PEN-NAMES-1 (migration 20261019184512): the Author Page is keyed by a
// pen name id and reads the public_pen_names view. Rendered from the real
// Server Component over an in-memory table stub that applies eq/in/not
// filters, so a query on the wrong column shows up as missing content.

type Row = Record<string, unknown>;
type QueryLog = { table: string; select: string; filters: string[] };

class NotFoundSignal extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFoundSignal("NOT_FOUND");
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

function tableQuery(table: string, rows: Row[], log: QueryLog[]) {
  let result = rows.map((r) => ({ ...r }));
  let mode: "list" | "single" | "count" = "list";
  const entry: QueryLog = { table, select: "*", filters: [] };
  log.push(entry);
  const builder: Record<string, unknown> = {
    select(cols: string, opts?: { head?: boolean }) {
      entry.select = cols;
      if (opts?.head) mode = "count";
      return builder;
    },
    eq(col: string, value: unknown) {
      entry.filters.push(`eq:${col}`);
      result = result.filter((r) => r[col] === value);
      return builder;
    },
    in(col: string, values: unknown[]) {
      entry.filters.push(`in:${col}`);
      result = result.filter((r) => values.includes(r[col]));
      return builder;
    },
    not(col: string) {
      entry.filters.push(`not-null:${col}`);
      result = result.filter((r) => r[col] !== null && r[col] !== undefined);
      return builder;
    },
    order() {
      return builder;
    },
    returns() {
      return builder;
    },
    single() {
      mode = "single";
      return builder;
    },
    maybeSingle() {
      mode = "single";
      return builder;
    },
    then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
      const value =
        mode === "count"
          ? { count: result.length, data: null, error: null }
          : mode === "single"
            ? { data: result[0] ?? null, error: null }
            : { data: result, error: null };
      return Promise.resolve(value).then(onFulfilled, onRejected);
    },
  };
  return builder;
}

function withoutAccount(row: Row): Row {
  const rest = { ...row };
  delete rest.author_id;
  return rest;
}

let tables: Record<string, Row[]> = {};
let adminTables: Record<string, Row[]> = {};
let userId: string | null = null;
let staff = false;
let log: QueryLog[] = [];
let adminLog: QueryLog[] = [];

function client(source: () => Record<string, Row[]>, into: () => QueryLog[]) {
  return {
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) },
    from: (table: string) => {
      const all = source();
      if (!(table in all)) throw new Error(`stub: unexpected table ${table}`);
      return tableQuery(table, all[table], into());
    },
    storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.example/${p}` } }) }) },
  };
}

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client(() => tables, () => log) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => client(() => adminTables, () => adminLog) }));
vi.mock("@/lib/staff", () => ({ hasPermission: async (permission: string) => staff && permission === "reports.resolve" }));
vi.mock("./actions", () => ({
  followPenName: vi.fn(),
  unfollowPenName: vi.fn(),
  removePenNameLinks: vi.fn(),
}));

const { default: AuthorProfilePage, generateMetadata } = await import("./page");

const ACCOUNT = "aaaaaaaa-0000-4000-8000-000000000001";
const READER = "aaaaaaaa-0000-4000-8000-000000000002";
const PEN_A = "bbbbbbbb-0000-4000-8000-00000000000a";
const PEN_B = "bbbbbbbb-0000-4000-8000-00000000000b";

function book(id: string, title: string, pen: string, extra: Row = {}): Row {
  return {
    id, title, author_id: ACCOUNT, pen_name_id: pen, status: "published", price_all: 199, price_cents: 0,
    genre: null, cover_path: null, series_id: null, series_position: null, created_at: "2026-10-01T00:00:00Z",
    ...extra,
  };
}

function install(overrides: { penA?: Row; user?: string | null; staff?: boolean; follows?: Row[] } = {}) {
  userId = overrides.user ?? null;
  staff = overrides.staff ?? false;
  log = [];
  adminLog = [];
  const penA = { id: PEN_A, name: "Ëngjëll Çela", bio: null, avatar_path: null, links: [], ...overrides.penA };
  tables = {
    public_pen_names: [penA, { id: PEN_B, name: "Arben Leka", bio: "Other bio", avatar_path: null, links: [] }],
    // RLS: a signed-in author sees only their own pen names.
    pen_names: userId === ACCOUNT ? [{ id: PEN_A, author_id: ACCOUNT }, { id: PEN_B, author_id: ACCOUNT }] : [],
    // PEN-NAMES-2: the page reads books, bundles and series through the
    // public views, which carry no author_id. There is no base books,
    // bundles or series table here, so a base read would throw.
    public_books: [book("book-a1", "Libri i Penës A", PEN_A), book("book-b1", "Libri i Penës B", PEN_B)].map(withoutAccount),
    public_bundles: [
      { id: "bundle-a", title: "Pako A", price_all: 299, pen_name_id: PEN_A, status: "published" },
      { id: "bundle-b", title: "Pako B", price_all: 299, pen_name_id: PEN_B, status: "published" },
    ],
    pen_name_follows: overrides.follows ?? [],
    public_series: [],
  };
  adminTables = {
    pen_name_follows: [
      { follower_id: READER, pen_name_id: PEN_A },
      { follower_id: "x", pen_name_id: PEN_B },
      { follower_id: "y", pen_name_id: PEN_B },
    ],
    pen_names: [{ id: PEN_A, author_id: ACCOUNT }, { id: PEN_B, author_id: ACCOUNT }],
    profiles: [{ id: ACCOUNT, public_author_name: "Arben Leka" }],
  };
}

async function render(id = PEN_A): Promise<string> {
  const element = await AuthorProfilePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]).replace(/<script>[\s\S]*?<\/script>/g, "");
}

describe("PEN-NAMES-1 Author Page", () => {
  it("is keyed by the pen name id: its name, only its books and bundles, its own follower count (1a, 4a)", async () => {
    install();
    const html = await render();
    expect(html).toContain("Ëngjëll Çela");
    expect(html).toContain("Libri i Penës A");
    expect(html).toContain("Pako A");
    expect(html).not.toContain("Libri i Penës B");
    expect(html).not.toContain("Pako B");
    expect(html).not.toContain("Arben Leka");
    expect(html).toContain("1 ndjekës");
    expect(log.find((q) => q.table === "public_pen_names")?.select).toBe("id, name, bio, avatar_path, links");
    expect(log.filter((q) => q.table === "public_books" || q.table === "public_bundles").every((q) => q.filters.includes("eq:pen_name_id"))).toBe(true);
    expect(log.some((q) => q.table === "books" || q.table === "bundles" || q.table === "series")).toBe(false);
    expect(log.some((q) => q.filters.includes("eq:author_id") && q.table !== "pen_names")).toBe(false);
  });

  it("never links to the account or the author's other pen names", async () => {
    install();
    const html = await render();
    expect(html).not.toContain(ACCOUNT);
    expect(html).not.toContain(PEN_B);
  });

  it("empty: no bio, photo or links shows nothing for them -- no placeholder line (7a)", async () => {
    install();
    const html = await render();
    expect(html).not.toContain("No biography added yet.");
    expect(html).not.toContain("rel=");
    expect(html).not.toContain("<img");
  });

  it("filled: bio, photo and up to 3 https links, as nofollow ugc links (2a, 8a)", async () => {
    install({
      penA: {
        bio: "Shkruan poezi.",
        avatar_path: "cccccccc-0000-4000-8000-000000000001/pen-name.jpg",
        links: ["https://example.com/a", "http://insecure.example", "https://example.org/b"],
      },
    });
    const html = await render();
    expect(html).toContain("Shkruan poezi.");
    expect(html).toContain('src="https://cdn.example/cccccccc-0000-4000-8000-000000000001/pen-name.jpg"');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).toContain('href="https://example.org/b"');
    expect(html).not.toContain("http://insecure.example");
    expect(html.match(/rel="nofollow ugc noopener noreferrer"/g)).toHaveLength(2);
  });

  it("an old /autore/<account id> URL, an unknown id or a malformed id is not found", async () => {
    install();
    await expect(render(ACCOUNT)).rejects.toBeInstanceOf(NotFoundSignal);
    await expect(render("not-a-uuid")).rejects.toBeInstanceOf(NotFoundSignal);
    expect(await generateMetadata({ params: Promise.resolve({ id: ACCOUNT }) })).toEqual({});
  });

  it("metadata comes from the pen name", async () => {
    install();
    expect(await generateMetadata({ params: Promise.resolve({ id: PEN_A }) })).toEqual({
      title: "Ëngjëll Çela",
      description: "Librat dhe të dhënat për autorin Ëngjëll Çela në Librum.",
    });
  });

  it("a signed-in reader gets Follow / Following for this pen name", async () => {
    install({ user: READER });
    expect(await render()).toMatch(/>Ndiqni<\/button>/);
    install({ user: READER, follows: [{ follower_id: READER, pen_name_id: PEN_A }] });
    expect(await render()).toMatch(/>Po e ndiqni<\/button>/);
  });

  it("the author gets no Follow control on their own pen name", async () => {
    install({ user: ACCOUNT });
    const html = await render();
    expect(html).not.toContain(">Ndiqni<");
    expect(html).not.toContain("Hyni për ta ndjekur");
  });

  it("staff with reports.resolve see the account behind the pen name and Remove links (13a); nobody else does", async () => {
    install({ user: READER, staff: true, penA: { links: ["https://example.com/a"] } });
    const html = await render();
    expect(html).toContain("Staff:");
    expect(html).toContain(ACCOUNT);
    expect(html).toContain("Remove links");

    install({ user: READER, staff: false, penA: { links: ["https://example.com/a"] } });
    const plain = await render();
    expect(plain).not.toContain("Staff:");
    expect(plain).not.toContain("Remove links");
    expect(plain).not.toContain(ACCOUNT);
    expect(adminLog.some((q) => q.table === "profiles")).toBe(false);
  });
});
