import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 BLOG-1D: sitemap() became async once it gained its first
// dynamic, DB-backed entries (every published /blog/[slug]) -- the
// Supabase client is mocked here the same way every other public-data
// test in this codebase mocks it, rather than hitting a real database.
// P2: one recorded, chainable query per from() call, so each table's
// filters can be checked; .range() slices that table's rows, as
// PostgREST's own row windows do.
type Call = { method: string; args: unknown[] };
type Query = { table: string; calls: Call[] };
let tableRows: Record<string, unknown[]> = {};
let queries: Query[] = [];

function mockQuery(table: string) {
  const query: Query = { table, calls: [] };
  queries.push(query);
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "order", "range", "returns"]) {
    builder[method] = (...args: unknown[]) => {
      query.calls.push({ method, args });
      return builder;
    };
  }
  builder.then = (resolve: (value: unknown) => unknown) => {
    const rows = tableRows[table] ?? [];
    const range = query.calls.find((call) => call.method === "range");
    const data = range ? rows.slice(range.args[0] as number, (range.args[1] as number) + 1) : rows;
    return Promise.resolve({ data }).then(resolve);
  };
  return builder;
}

const mockCreateClient = vi.fn(() => Promise.resolve({ from: (table: string) => mockQuery(table) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { default: sitemap } = await import("./sitemap");

const queriesOf = (table: string) => queries.filter((query) => query.table === table);
const argsOf = (query: Query, method: string) =>
  query.calls.filter((call) => call.method === method).map((call) => call.args);

const BOOK_A = "00000000-0000-4000-8000-00000000000a";
const BOOK_B = "00000000-0000-4000-8000-00000000000b";
const PEN_1 = "00000000-0000-4000-8000-0000000000e1";
const SERIES_1 = "00000000-0000-4000-8000-0000000000c1";
const BUNDLE_1 = "00000000-0000-4000-8000-0000000000d1";

describe("sitemap", () => {
  beforeEach(() => {
    queries = [];
    tableRows = {
      blog_posts: [
        { slug: "how-to-publish", updated_at: "2026-01-15T00:00:00Z" },
        { slug: "what-is-isbn", updated_at: "2026-02-01T00:00:00Z" },
      ],
      public_books: [
        { id: BOOK_A, pen_name_id: PEN_1, series_id: SERIES_1, updated_at: "2026-09-01T00:00:00Z" },
        { id: BOOK_B, pen_name_id: PEN_1, series_id: null, updated_at: "2026-09-05T00:00:00Z" },
      ],
      public_bundles: [{ id: BUNDLE_1, updated_at: "2026-09-03T00:00:00Z" }],
    };
  });

  it("includes every static public/marketing route", async () => {
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    for (const path of [
      "/",
      "/rreth-nesh",
      "/si-funksionon",
      "/fitimet",
      "/librari",
      "/ndihme",
      "/ndihme/leximi",
      "/kontakt",
      "/kushtet",
      "/privatesia",
      "/rimbursimet",
    ]) {
      expect(paths).toContain(path);
    }
  });

  it("includes /blog itself", async () => {
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    expect(paths).toContain("/blog");
  });

  it("includes every published /blog/[slug] with its real updated_at as lastModified", async () => {
    const entries = await sitemap();
    const blogEntry = entries.find((e) => new URL(e.url).pathname === "/blog/how-to-publish");
    expect(blogEntry).toBeDefined();
    expect(blogEntry?.lastModified).toEqual(new Date("2026-01-15T00:00:00Z"));

    const secondEntry = entries.find((e) => new URL(e.url).pathname === "/blog/what-is-isbn");
    expect(secondEntry).toBeDefined();
  });

  it("queries only status='published' -- drafts are filtered at the query level, matching every other public Blog query", async () => {
    await sitemap();
    expect(argsOf(queriesOf("blog_posts")[0], "eq")).toContainEqual(["status", "published"]);
  });

  it("selects only slug and updated_at -- never article bodies", async () => {
    await sitemap();
    const selectArg = argsOf(queriesOf("blog_posts")[0], "select")[0][0] as string;
    expect(selectArg).not.toContain("*");
    expect(selectArg).not.toContain("content_markdown");
    expect(selectArg).toContain("slug");
    expect(selectArg).toContain("updated_at");
  });

  it("never includes the retired /products or /program placeholders", async () => {
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    expect(paths).not.toContain("/products");
    expect(paths).not.toContain("/program");
  });

  it("never includes any authenticated/private route", async () => {
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    for (const path of paths) {
      expect(path.startsWith("/dashboard")).toBe(false);
      expect(path.startsWith("/account")).toBe(false);
      expect(path.startsWith("/admin")).toBe(false);
      expect(path.startsWith("/library")).toBe(false);
      expect(path.startsWith("/wishlist")).toBe(false);
      expect(path.startsWith("/following")).toBe(false);
    }
  });

  it("never includes an auth-flow route", async () => {
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    for (const path of paths) {
      expect(path.startsWith("/login")).toBe(false);
      expect(path.startsWith("/signup")).toBe(false);
      expect(path.startsWith("/forgot-password")).toBe(false);
      expect(path.startsWith("/reset-password")).toBe(false);
    }
  });

  it("produces absolute, well-formed URLs", async () => {
    const entries = await sitemap();
    for (const entry of entries) {
      expect(() => new URL(entry.url)).not.toThrow();
    }
  });

  it("with zero published posts, still includes /blog and no blog article entries", async () => {
    tableRows.blog_posts = [];
    const entries = await sitemap();
    const paths = entries.map((entry) => new URL(entry.url).pathname);
    expect(paths).toContain("/blog");
    expect(paths.filter((p) => p.startsWith("/blog/"))).toHaveLength(0);
  });

  // P2 (Renato 10-29): books, authors, series and bundles.
  describe("catalog pages", () => {
    it("lists each published, priced book at /libra/<id> with its own updated_at", async () => {
      const entries = await sitemap();
      const book = entries.find((e) => new URL(e.url).pathname === `/libra/${BOOK_A}`);
      expect(book?.lastModified).toEqual(new Date("2026-09-01T00:00:00Z"));
      expect(entries.some((e) => new URL(e.url).pathname === `/libra/${BOOK_B}`)).toBe(true);
    });

    it("lists each of those books' pen names once at /autore/<pen name id>, dated by its newest book", async () => {
      const entries = await sitemap();
      const authors = entries.filter((e) => new URL(e.url).pathname.startsWith("/autore/"));
      expect(authors.map((e) => new URL(e.url).pathname)).toEqual([`/autore/${PEN_1}`]);
      expect(authors[0].lastModified).toEqual(new Date("2026-09-05T00:00:00Z"));
    });

    it("lists each of those books' series at /seri/<id>, and a book with no series adds none", async () => {
      const entries = await sitemap();
      const series = entries.filter((e) => new URL(e.url).pathname.startsWith("/seri/"));
      expect(series.map((e) => new URL(e.url).pathname)).toEqual([`/seri/${SERIES_1}`]);
    });

    it("lists each published, priced bundle at /paketa/<id>", async () => {
      const entries = await sitemap();
      const bundle = entries.find((e) => new URL(e.url).pathname === `/paketa/${BUNDLE_1}`);
      expect(bundle?.lastModified).toEqual(new Date("2026-09-03T00:00:00Z"));
    });

    it("reads books and bundles through the public views, published and priced only, explicitly", async () => {
      await sitemap();
      for (const table of ["public_books", "public_bundles"]) {
        const [query] = queriesOf(table);
        expect(argsOf(query, "eq")).toContainEqual(["status", "published"]);
        expect(argsOf(query, "not")).toContainEqual(["price_all", "is", null]);
      }
      expect(queriesOf("books")).toHaveLength(0);
      expect(queriesOf("bundles")).toHaveLength(0);
      expect(queriesOf("pen_names")).toHaveLength(0);
    });

    it("never selects an account column", async () => {
      await sitemap();
      for (const table of ["public_books", "public_bundles"]) {
        const select = argsOf(queriesOf(table)[0], "select")[0][0] as string;
        expect(select).not.toContain("*");
        expect(select).not.toContain("author_id");
      }
    });

    it("reads past Supabase's 1000-row limit in id-ordered pages", async () => {
      tableRows.public_books = Array.from({ length: 1500 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        pen_name_id: null,
        series_id: null,
        updated_at: "2026-09-01T00:00:00Z",
      }));
      const entries = await sitemap();
      expect(entries.filter((e) => new URL(e.url).pathname.startsWith("/libra/"))).toHaveLength(1500);
      const bookQueries = queriesOf("public_books");
      expect(bookQueries.map((query) => argsOf(query, "range")[0])).toEqual([
        [0, 999],
        [1000, 1999],
      ]);
      expect(argsOf(bookQueries[0], "order")).toEqual([["id"]]);
    });

    it("with an empty catalog, lists no book, author, series or bundle", async () => {
      tableRows.public_books = [];
      tableRows.public_bundles = [];
      const paths = (await sitemap()).map((e) => new URL(e.url).pathname);
      expect(paths.filter((p) => /^\/(libra|autore|seri|paketa)\//.test(p))).toHaveLength(0);
      expect(queriesOf("public_books")).toHaveLength(1);
    });
  });
});
