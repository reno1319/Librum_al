import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// BUILD 2b (b1 a, pf2 a): the public house page, rendered from the real
// Server Component over the same in-memory table stub as the author page.
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
    neq(col: string, value: unknown) {
      entry.filters.push(`neq:${col}`);
      result = result.filter((r) => r[col] !== value);
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

let tables: Record<string, Row[]> = {};
let adminTables: Record<string, Row[]> = {};
let userId: string | null = null;
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
vi.mock("../../autore/[id]/actions", () => ({ followPenName: vi.fn(), unfollowPenName: vi.fn() }));

const { default: PublishingHousePage, generateMetadata } = await import("./page");

const HOUSE = "bbbbbbbb-0000-4000-8000-00000000000a";
const AUTHOR_1 = "bbbbbbbb-0000-4000-8000-00000000000b";
const AUTHOR_2 = "bbbbbbbb-0000-4000-8000-00000000000c";
const OTHER = "bbbbbbbb-0000-4000-8000-00000000000d";

function book(id: string, title: string, pen: string): Row {
  return {
    id, title, pen_name_id: pen, status: "published", price_all: 500, price_cents: 0, genre: null,
    cover_path: null, series_id: null, created_at: "2026-10-01T00:00:00Z", is_adult: false,
  };
}

function install(user: string | null = null) {
  userId = user;
  log = [];
  adminLog = [];
  const pen = (id: string, name: string, house: string | null, extra: Row = {}) => ({
    id, name, bio: null, avatar_path: null, links: [], house_id: house, linked_pen_name_id: null, ...extra,
  });
  tables = {
    public_pen_names: [
      pen(HOUSE, "Botime Test", HOUSE, { bio: "TË DHËNA TESTI. Një shtëpi botuese." }),
      pen(AUTHOR_1, "Besnik Test", HOUSE),
      pen(AUTHOR_2, "Arta Test", HOUSE),
      pen(OTHER, "Autor Tjetër", null),
    ],
    pen_names: [],
    public_books: [
      book("b1", "Lumi i heshtur", AUTHOR_2),
      book("b2", "Antologjia", HOUSE),
      book("b3", "Libër i dikujt tjetër", OTHER),
    ],
    pen_name_follows: [],
  };
  adminTables = { pen_name_follows: [{ follower_id: "x", pen_name_id: HOUSE }, { follower_id: "y", pen_name_id: AUTHOR_1 }] };
}

async function render(id = HOUSE): Promise<string> {
  const element = await PublishingHousePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
}

describe("BUILD 2b public house page", () => {
  it("shows the label, name, about, its own follower count, the authors and every house book with its author", async () => {
    install();
    const html = await render();
    expect(html).toContain("Shtëpi botuese");
    expect(html).toContain("Botime Test");
    expect(html).toContain("TË DHËNA TESTI. Një shtëpi botuese.");
    expect(html).toMatch(/>1(<!-- -->)? ndjekës</);
    expect(html).toContain(`href="/autore/${AUTHOR_1}"`);
    expect(html).toContain("Arta Test");
    expect(html).toContain("Lumi i heshtur");
    expect(html).toContain("Antologjia");
    expect(html).not.toContain("Libër i dikujt tjetër");
    expect(html).not.toContain("Autor Tjetër");
    expect(html).toContain(`href="/login?next=/shtepi-botuese/${HOUSE}"`);
    expect(log.some((q) => q.filters.includes("eq:author_id") && q.table !== "pen_names")).toBe(false);
  });

  it("is not found for an author's pen name, a house author, or an unknown id", async () => {
    install();
    await expect(render(OTHER)).rejects.toThrow("NOT_FOUND");
    await expect(render(AUTHOR_1)).rejects.toThrow("NOT_FOUND");
    await expect(render("not-a-uuid")).rejects.toThrow("NOT_FOUND");
  });

  it("has the house name as its title and the house page as canonical", async () => {
    install();
    const meta = await generateMetadata({ params: Promise.resolve({ id: HOUSE }) });
    expect(meta.title).toBe("Botime Test");
    expect(JSON.stringify(meta)).toContain(`/shtepi-botuese/${HOUSE}`);
    install();
    expect(await generateMetadata({ params: Promise.resolve({ id: AUTHOR_1 }) })).toEqual({});
  });
});
