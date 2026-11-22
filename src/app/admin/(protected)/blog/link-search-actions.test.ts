import { beforeEach, describe, expect, it, vi } from "vitest";

// Blog link search (2026-11-22, lk2 a, lk4 a): staff-only, and every read
// uses the PUBLIC key with no session, so only what a visitor can open
// is found.
const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (p: string) => mockRequireStaff(p) }));
vi.mock("@/lib/supabase/env-guard", () => ({ assertSupabaseEnvSafeForExecution: vi.fn() }));

type Result = { data: unknown; error: { code?: string } | null };
let rpcResults: Record<string, Result>;
let tableResults: Record<string, Result>;
const calls: { table: string; ops: [string, unknown[]][] }[] = [];
const createClientSpy = vi.fn();

function query(table: string) {
  const entry = { table, ops: [] as [string, unknown[]][] };
  calls.push(entry);
  const q: Record<string, unknown> = {};
  for (const op of ["select", "in", "eq", "not", "order", "limit"]) {
    q[op] = (...args: unknown[]) => {
      entry.ops.push([op, args]);
      return q;
    };
  }
  q.returns = () => Promise.resolve(tableResults[table] ?? { data: [], error: null });
  return q;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => {
    createClientSpy(...args);
    return {
      rpc: (name: string, params: unknown) => {
        calls.push({ table: `rpc:${name}`, ops: [["params", [params]]] });
        return Promise.resolve(rpcResults[name] ?? { data: [], error: null });
      },
      from: query,
      storage: { from: () => ({ getPublicUrl: (p: string) => ({ data: { publicUrl: `https://cdn.test/covers/${p}` } }) }) },
    };
  },
}));

const { searchBlogLinkTargets } = await import("./link-search-actions");

beforeEach(() => {
  calls.length = 0;
  createClientSpy.mockClear();
  mockRequireStaff.mockReset();
  mockRequireStaff.mockResolvedValue({ userId: "u1", role: "editor" });
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://dummyreffortestingx0.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  rpcResults = {
    search_books: { data: [{ book_id: "b1" }, { book_id: "b2" }], error: null },
    search_blog_posts: { data: [{ post_id: "p2" }, { post_id: "p1" }], error: null },
  };
  tableResults = {
    public_books: {
      data: [
        { id: "b2", title: "Një plan për verën", cover_path: null, pen: { name: "Elira" } },
        { id: "b1", title: "Plani i madh", cover_path: "c/1.jpg", pen: { name: "Arben" } },
      ],
      error: null,
    },
    public_pen_names: {
      data: [
        { id: "a1", name: "Arben Planaj" },
        { id: "a2", name: "Zana Çela" },
      ],
      error: null,
    },
    blog_posts: {
      data: [
        { id: "p1", title: "Plani", slug: "plani" },
        { id: "p2", title: "Si ta shkruash", slug: "si-ta-shkruash" },
      ],
      error: null,
    },
  };
});

describe("searchBlogLinkTargets", () => {
  it("is staff-only (blog.manage) before any read", async () => {
    mockRequireStaff.mockRejectedValue(new Error("REDIRECT:/"));
    await expect(searchBlogLinkTargets("plan")).rejects.toThrow("REDIRECT");
    expect(mockRequireStaff).toHaveBeenCalledWith("blog.manage");
    expect(createClientSpy).not.toHaveBeenCalled();
  });

  it("reads with the public key and no session, never the service role", async () => {
    await searchBlogLinkTargets("plan");
    expect(createClientSpy).toHaveBeenCalledWith("https://dummyreffortestingx0.supabase.co", "anon-key", {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    expect(JSON.stringify(createClientSpy.mock.calls)).not.toContain("service-key");
  });

  it("finds books, authors and articles with their Librum addresses", async () => {
    const r = await searchBlogLinkTargets("plan");
    expect(r).toEqual({
      ok: true,
      hits: [
        { kind: "book", href: "/libra/b1", title: "Plani i madh", subtitle: "Arben · libër", imageUrl: "https://cdn.test/covers/c/1.jpg" },
        { kind: "book", href: "/libra/b2", title: "Një plan për verën", subtitle: "Elira · libër", imageUrl: null },
        { kind: "author", href: "/autore/a1", title: "Arben Planaj", subtitle: "faqja e autorit", imageUrl: null },
        { kind: "post", href: "/blog/si-ta-shkruash", title: "Si ta shkruash", subtitle: "artikull në blog", imageUrl: null },
        { kind: "post", href: "/blog/plani", title: "Plani", subtitle: "artikull në blog", imageUrl: null },
      ],
    });
  });

  it("only listed books (published + pre-order) with a price, only published articles", async () => {
    await searchBlogLinkTargets("plan");
    const books = calls.find((c) => c.table === "public_books")!;
    expect(books.ops).toContainEqual(["in", ["status", ["published", "preorder"]]]);
    expect(books.ops).toContainEqual(["not", ["price_all", "is", null]]);
    const posts = calls.find((c) => c.table === "blog_posts")!;
    expect(posts.ops).toContainEqual(["eq", ["status", "published"]]);
  });

  it("matches authors accent-blind", async () => {
    const r = await searchBlogLinkTargets("cela");
    expect(r.ok && r.hits.filter((h) => h.kind === "author").map((h) => h.title)).toEqual(["Zana Çela"]);
  });

  it("drops wildcards and skips 1-letter searches", async () => {
    expect(await searchBlogLinkTargets("%")).toEqual({ ok: true, hits: [] });
    expect(calls).toHaveLength(0);
    await searchBlogLinkTargets("pl%an");
    const params = calls.find((c) => c.table === "rpc:search_books")!.ops[0][1][0] as { search_term: string };
    expect(params.search_term).toBe("pl an");
  });

  it("returns ok:false (no details) when a read fails", async () => {
    rpcResults.search_blog_posts = { data: null, error: { code: "42501" } };
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await searchBlogLinkTargets("plan")).toEqual({ ok: false });
    spy.mockRestore();
  });
});
