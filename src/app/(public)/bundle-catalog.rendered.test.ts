import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ALL-WIRING-5: RENDERED coverage of every active bundle catalog
// surface -- the bookstore rail, an author's public rail, the bundle
// detail page, and the author's own bundle list and edit form. Each page
// is the real async Server Component, rendered to HTML with
// renderToStaticMarkup, against an in-memory Supabase double that
// actually EVALUATES the filters and projections the page asks for.
//
// That last property is what makes these render tests rather than
// source scans: the double does not know which rows "should" be
// excluded. If a page stops asking for `.not("price_all", "is", null)`,
// the unpriced bundle is returned and rendered, and the assertions below
// see it. If a page stops selecting `price_all`, the column is projected
// away and the label reads "Price unavailable". Every unsupported
// builder method throws, so a page cannot pass by calling something the
// double silently ignores.
//
// Every fixture carries a legacy `price_cents` that DISAGREES with its
// `price_all`, so a surface that read the legacy column would render a
// visibly wrong answer ($25.00, Free for a paid bundle, or a savings
// figure computed from cents).

type Row = Record<string, unknown>;

// Splits a PostgREST select list on top-level commas and returns, per
// item, the key it produces in the result row ("*" for all columns).
function projectedKeys(columns: string): string[] | "*" {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of columns) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  if (items.includes("*")) return "*";
  return items.map((item) => {
    const head = item.split("(")[0];
    return head.includes(":") ? head.split(":")[0].trim() : head.trim();
  });
}

type QueryLog = { table: string; select: string; filters: string[] };

function tableQuery(table: string, rows: Row[], log: QueryLog[]) {
  let result = rows.map((r) => ({ ...r }));
  let mode: "list" | "single" | "count" = "list";
  let columns = "*";
  const entry: QueryLog = { table, select: "*", filters: [] };
  log.push(entry);

  const builder: Record<string, unknown> = {
    select(cols: string, opts?: { head?: boolean; count?: string }) {
      columns = cols;
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
    not(col: string, op: string, value: unknown) {
      if (op !== "is" || value !== null) throw new Error(`stub: unsupported not(${op})`);
      entry.filters.push(`not-null:${col}`);
      result = result.filter((r) => r[col] !== null && r[col] !== undefined);
      return builder;
    },
    order(col: string, opts?: { ascending?: boolean }) {
      const dir = opts?.ascending === false ? -1 : 1;
      result = [...result].sort((a, b) => (String(a[col]) < String(b[col]) ? -dir : String(a[col]) > String(b[col]) ? dir : 0));
      return builder;
    },
    limit(n: number) {
      result = result.slice(0, n);
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
      const keys = projectedKeys(columns);
      const project = (r: Row) =>
        keys === "*" ? r : Object.fromEntries(keys.filter((k) => k in r).map((k) => [k, r[k]]));
      const projected = result.map(project);
      const value =
        mode === "count"
          ? { count: projected.length, data: null, error: null }
          : mode === "single"
            ? { data: projected[0] ?? null, error: projected[0] ? null : { message: "no rows" } }
            : { data: projected, error: null };
      return Promise.resolve(value).then(onFulfilled, onRejected);
    },
  };
  return new Proxy(builder, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      throw new Error(`stub: unsupported query builder method ${String(prop)} on ${table}`);
    },
  });
}

function makeClient(tables: Record<string, Row[]>, userId: string | null, log: QueryLog[]) {
  return {
    auth: { getUser: async () => ({ data: { user: userId ? { id: userId } : null } }) },
    from: (table: string) => {
      if (!(table in tables)) throw new Error(`stub: unexpected table ${table}`);
      return tableQuery(table, tables[table], log);
    },
    rpc: async (name: string) => {
      if (name === "user_owns_book") return { data: false, error: null };
      throw new Error(`stub: unexpected rpc ${name}`);
    },
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://cdn.example/c.png" } }) }) },
  };
}

let currentClient: ReturnType<typeof makeClient>;
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => currentClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => currentClient }));
vi.mock("./authors/[id]/actions", () => ({ followAuthor: vi.fn(), unfollowAuthor: vi.fn() }));
vi.mock("./bundles/[id]/actions", () => ({ buyBundle: vi.fn() }));
vi.mock("./dashboard/bundles/actions", () => ({
  createBundle: vi.fn(),
  updateBundle: vi.fn(),
  publishBundle: vi.fn(),
  unpublishBundle: vi.fn(),
  deleteBundle: vi.fn(),
}));

const { default: BookstorePage } = await import("./bookstore/page");
const { default: AuthorProfilePage } = await import("./authors/[id]/page");
const { default: BundleDetailPage } = await import("./bundles/[id]/page");
const { default: BundlesDashboardPage } = await import("./dashboard/bundles/page");
const { default: EditBundlePage } = await import("./dashboard/bundles/[id]/edit/page");

async function render(element: Promise<unknown>): Promise<string> {
  return renderToStaticMarkup((await element) as Parameters<typeof renderToStaticMarkup>[0]);
}

const AUTHOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_AUTHOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const READER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AUTHOR_PROFILE = { public_author_name: "Arta Autore" };

function bundle(id: string, title: string, priceAll: number | null, priceCents: number, extra: Row = {}): Row {
  return {
    id,
    author_id: AUTHOR,
    title,
    description: "",
    status: "published",
    price_all: priceAll,
    price_cents: priceCents,
    created_at: `2026-09-${id.slice(-2)}T00:00:00Z`,
    profiles: AUTHOR_PROFILE,
    ...extra,
  };
}

// The discovery fixtures. Titles are unique so presence is unambiguous.
const PAID = bundle("bundle-paid-21", "Paid Collection", 199, 0);
const UNPRICED = bundle("bundle-null-22", "Unpriced Collection", null, 2500);
const FREE = bundle("bundle-free-23", "Free Collection", 0, 1500);
const DRAFT = bundle("bundle-draft-24", "Draft Collection", 299, 0, { status: "draft" });
const FOREIGN = bundle("bundle-foreign-25", "Someone Else's Collection", 499, 0, { author_id: OTHER_AUTHOR });

function book(id: string, title: string, priceAll: number | null, priceCents: number): Row {
  return {
    id,
    title,
    author_id: AUTHOR,
    status: "published",
    price_all: priceAll,
    price_cents: priceCents,
    genre: null,
    cover_path: null,
    series_id: null,
    created_at: "2026-09-01T00:00:00Z",
  };
}

let log: QueryLog[] = [];

function install(tables: Record<string, Row[]>, userId: string | null = READER) {
  log = [];
  currentClient = makeClient(tables, userId, log);
}

// React appends an inline form-replay <script> (its own `$$react...`
// identifiers) whenever a page contains a server-action form. That is
// framework code, not page content, so it is removed before scanning.
function visible(html: string): string {
  return html.replace(/<script>[\s\S]*?<\/script>/g, "");
}

function noDollarOrUsd(html: string) {
  expect(visible(html)).not.toContain("$");
  expect(visible(html)).not.toMatch(/\bUSD\b/);
}

// The rendered <input name="price" ...> tag, whatever order React emits
// its attributes in.
function priceInput(html: string): string {
  const tag = html.match(/<input[^>]*name="price"[^>]*>/);
  expect(tag).not.toBeNull();
  return tag![0];
}

afterEach(() => vi.unstubAllEnvs());

// ------------------------------------------------------------------
// Discovery rails
// ------------------------------------------------------------------
describe("bookstore bundle rail (rendered)", () => {
  beforeEach(() => {
    install({
      books: [],
      bundles: [PAID, UNPRICED, FREE, DRAFT, FOREIGN],
    });
  });

  it("excludes the null-priced bundle and prices the rest from price_all", async () => {
    const html = await render(BookstorePage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Paid Collection");
    expect(html).toContain("199,00 ALL");
    expect(html).toContain("Free Collection");
    expect(html).not.toContain("Unpriced Collection");
    expect(html).not.toContain("Draft Collection");
  });

  it("the 199 / price_cents 0 bundle renders as paid, never Free or $0.00", async () => {
    install({ books: [], bundles: [PAID] });
    const html = await render(BookstorePage({ searchParams: Promise.resolve({}) }));

    const rail = html.slice(html.indexOf("Paid Collection"));
    expect(rail).toContain("199,00 ALL");
    expect(rail).not.toContain(">Free<");
    expect(html).not.toContain("$0.00");
  });

  it("explicitly free renders Free (from price_all 0, not from its legacy 1500 cents)", async () => {
    install({ books: [], bundles: [FREE] });
    const html = await render(BookstorePage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Free Collection");
    expect(html).toContain(">Free<");
    expect(html).not.toContain("15.00");
  });

  it("renders no dollar sign, no USD, and no legacy amount anywhere on the page", async () => {
    const html = await render(BookstorePage({ searchParams: Promise.resolve({}) }));
    noDollarOrUsd(html);
    expect(html).not.toContain("25.00");
    expect(html).not.toContain("Price unavailable");
  });

  it("asks for price_all, filters on it, and never selects or filters on price_cents", async () => {
    await render(BookstorePage({ searchParams: Promise.resolve({}) }));
    const bundleQueries = log.filter((q) => q.table === "bundles");
    expect(bundleQueries).toHaveLength(1);
    expect(bundleQueries[0].select).toContain("price_all");
    expect(bundleQueries[0].select).not.toContain("price_cents");
    expect(bundleQueries[0].filters).toContain("not-null:price_all");
    expect(bundleQueries[0].filters.join()).not.toContain("price_cents");
  });

  it("with only an unpriced bundle published, the rail does not render at all", async () => {
    install({ books: [], bundles: [UNPRICED] });
    const html = await render(BookstorePage({ searchParams: Promise.resolve({}) }));
    expect(html).not.toContain("Unpriced Collection");
    expect(html).not.toContain("Multiple books in one collection.");
  });
});

describe("author public bundle rail (rendered)", () => {
  function tables(bundles: Row[]) {
    return {
      public_author_profiles: [{ id: AUTHOR, public_author_name: "Arta Autore", bio: null, avatar_path: null }],
      books: [],
      bundles,
      author_follows: [],
      series: [],
    };
  }

  it("excludes the null-priced bundle and prices the rest from price_all", async () => {
    install(tables([PAID, UNPRICED, FREE, DRAFT, FOREIGN]));
    const html = await render(AuthorProfilePage({ params: Promise.resolve({ id: AUTHOR }) }));

    expect(html).toContain("Paid Collection");
    expect(html).toContain("199,00 ALL");
    expect(html).toContain("Free Collection");
    expect(html).toContain(">Free<");
    expect(html).not.toContain("Unpriced Collection");
    expect(html).not.toContain("Draft Collection");
    expect(html).not.toContain("Someone Else");
    noDollarOrUsd(html);
    expect(html).not.toContain("25.00");
  });

  it("asks for price_all, filters on it, and never selects price_cents", async () => {
    install(tables([PAID]));
    await render(AuthorProfilePage({ params: Promise.resolve({ id: AUTHOR }) }));
    const bundleQuery = log.find((q) => q.table === "bundles");
    expect(bundleQuery?.select).toContain("price_all");
    expect(bundleQuery?.select).not.toContain("price_cents");
    expect(bundleQuery?.select).not.toBe("*");
    expect(bundleQuery?.filters).toContain("not-null:price_all");
  });

  it("an author whose only bundle is unpriced shows no Bundles section", async () => {
    install(tables([UNPRICED]));
    const html = await render(AuthorProfilePage({ params: Promise.resolve({ id: AUTHOR }) }));
    expect(html).not.toContain(">Bundles<");
    expect(html).not.toContain("Unpriced Collection");
  });
});

// ------------------------------------------------------------------
// Bundle detail
// ------------------------------------------------------------------
describe("bundle detail page (rendered)", () => {
  function detail(bundleRow: Row, members: Array<Row | null>, userId: string | null = READER) {
    install(
      {
        bundles: [bundleRow],
        bundle_books: members.map((m, i) => ({
          bundle_id: bundleRow.id,
          book_id: m ? m.id : `hidden-${i}`,
          books: m,
        })),
      },
      userId,
    );
    return render(
      BundleDetailPage({
        params: Promise.resolve({ id: String(bundleRow.id) }),
        searchParams: Promise.resolve({}),
      }),
    );
  }

  const A = book("book-a", "Libri A", 150, 99_999);
  const B = book("book-b", "Libri B", 120, 99_999);

  function priceLine(html: string): string {
    const start = html.indexOf("text-xl font-semibold text-primary");
    return html.slice(start, html.indexOf("</div>", start));
  }

  it("a published null-priced bundle stays reachable and says Price unavailable -- never Free or $25.00", async () => {
    const html = await detail(UNPRICED, [A, B]);

    expect(html).toContain("Unpriced Collection");
    expect(priceLine(html)).toContain("Price unavailable");
    expect(priceLine(html)).not.toContain("Free");
    expect(html).not.toContain("25.00");
    expect(html).not.toContain("you save");
    expect(html).toContain("Not available right now");
    expect(html).not.toContain("Bundle checkout coming soon");
    noDollarOrUsd(html);
  });

  it("199 / price_cents 0 renders 199,00 ALL, never Free or $0.00", async () => {
    const html = await detail(PAID, [A, B]);
    expect(priceLine(html)).toContain("199,00 ALL");
    expect(priceLine(html)).not.toContain("Free");
    expect(html).not.toContain("$0.00");
    noDollarOrUsd(html);
  });

  it("computes original total and saving in whole lek from price_all only", async () => {
    // 150 + 120 = 270; 270 - 199 = 71. Legacy cents (99999 per book,
    // 0 for the bundle) would have produced a four-digit dollar saving.
    const html = await detail(PAID, [A, B]);
    const line = priceLine(html);
    expect(line).toContain('<span class="line-through">270,00 ALL</span>');
    expect(line).toContain("you save 71,00 ALL");
    expect(html).not.toContain("999");
  });

  it("an explicitly free member participates as zero because it IS free", async () => {
    const freeMember = book("book-free", "Libri Falas", 0, 777);
    const pricey = book("book-c", "Libri C", 300, 1);
    const html = await detail(PAID, [freeMember, pricey]);
    // 0 + 300 = 300; 300 - 199 = 101.
    expect(priceLine(html)).toContain("300,00 ALL");
    expect(priceLine(html)).toContain("you save 101,00 ALL");
  });

  it("one unpriced member withholds the comparison entirely -- it is never counted as zero", async () => {
    // Counting it as zero would claim 150 + 0 = 150 < 199: no saving,
    // or with a cheaper bundle a FALSE saving. Either way, not shown.
    const unpricedMember = book("book-null", "Libri Pa Çmim", null, 900);
    const html = await detail(bundle("bundle-cheap-26", "Cheap Collection", 99, 0), [A, unpricedMember]);
    expect(html).not.toContain("you save");
    expect(html).not.toContain("line-through");
    // The member is still listed, with its own honest state.
    expect(html).toContain("Libri Pa Çmim");
    expect(html).toContain("Price unavailable");
    expect(html).toContain("150,00 ALL");
  });

  it("a member this viewer cannot resolve also withholds the comparison", async () => {
    const html = await detail(bundle("bundle-cheap-27", "Cheap Collection", 99, 0), [A, B, null]);
    expect(html).not.toContain("you save");
  });

  it("a zero or negative difference is never presented as a saving", async () => {
    for (const bundlePrice of [270, 300]) {
      const html = await detail(bundle("bundle-even-28", "Even Collection", bundlePrice, 0), [A, B]);
      expect(html).not.toContain("you save");
      expect(html).not.toContain("line-through");
    }
  });

  it("a free bundle reads Free, may state its saving, and is not called paid bundle checkout", async () => {
    const html = await detail(FREE, [A, B]);
    expect(priceLine(html)).toContain(">Free<");
    expect(priceLine(html)).toContain("you save 270,00 ALL");
    expect(html).toContain("Bundle checkout coming soon");
    expect(html).not.toMatch(/paid bundle checkout/i);
    expect(html).not.toContain("15.00");
  });

  it("the checkout notice is non-interactive in every price state: no form, no button, no login link", async () => {
    for (const row of [PAID, UNPRICED, FREE]) {
      const html = await detail(row, [A, B]);
      expect(html).toContain('aria-disabled="true"');
      expect(html).not.toContain("<form");
      expect(html).not.toContain("<button");
      expect(html).not.toContain("/login?next=");
      expect(html).not.toContain("Buy bundle");
    }
  });

  it("member cards keep each book's own honest price", async () => {
    const unpricedMember = book("book-null", "Libri Pa Çmim", null, 900);
    const html = await detail(PAID, [A, unpricedMember]);
    expect(html).toContain("Libri A");
    expect(html).toContain("150,00 ALL");
    expect(html).toContain("Libri Pa Çmim");
    expect(html).toContain("Price unavailable");
    expect(html).not.toContain("9.00");
  });

  it("selects price_all and never price_cents for the bundle itself", async () => {
    await detail(PAID, [A, B]);
    const bundleQuery = log.find((q) => q.table === "bundles");
    expect(bundleQuery?.select).toContain("price_all");
    expect(bundleQuery?.select).not.toContain("price_cents");
    expect(bundleQuery?.select).not.toMatch(/(^|,\s*)\*/);
    // The detail read is NOT filtered on price: reachability is status-based.
    expect(bundleQuery?.filters).not.toContain("not-null:price_all");
  });

  it("the existing visibility rule is unchanged: an unpriced DRAFT is visible to its author and 404s for anyone else", async () => {
    const draftUnpriced = bundle("bundle-draft-29", "Draft Unpriced", null, 2500, { status: "draft" });

    const html = await detail(draftUnpriced, [A, B], AUTHOR);
    expect(html).toContain("Draft Unpriced");
    expect(html).toContain("Price unavailable");
    expect(html).toContain("This is your bundle");

    await expect(detail(draftUnpriced, [A, B], READER)).rejects.toThrow();
  });
});

// ------------------------------------------------------------------
// Author dashboard
// ------------------------------------------------------------------
describe("author bundle dashboard and edit form (rendered)", () => {
  const OWN_BOOKS = [book("book-a", "Libri A", 150, 1), book("book-b", "Libri B", 120, 1)];

  it("keeps the author's null-priced bundle listed, labelled Price unavailable, so it can be repaired", async () => {
    install({ books: OWN_BOOKS, bundles: [PAID, UNPRICED, FREE, DRAFT], bundle_books: [] }, AUTHOR);
    const html = await render(BundlesDashboardPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Unpriced Collection");
    expect(html).toContain("Price unavailable");
    expect(html).toContain("Paid Collection");
    expect(html).toContain("199,00 ALL");
    expect(html).toContain("Free Collection");
    expect(html).toContain("Draft Collection");
    expect(html).toContain("299,00 ALL");
    noDollarOrUsd(html);
    expect(html).not.toContain("25.00");
  });

  it("the create form takes whole lek in a decimal text field labelled ALL", async () => {
    install({ books: OWN_BOOKS, bundles: [], bundle_books: [] }, AUTHOR);
    const html = await render(BundlesDashboardPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Bundle price (ALL)");
    const input = priceInput(html);
    expect(input).toContain('type="text"');
    expect(input).toContain('inputMode="decimal"');
    expect(input).toContain('required=""');
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain('step="0.01"');
  });

  it("the dashboard never selects price_cents", async () => {
    install({ books: OWN_BOOKS, bundles: [PAID], bundle_books: [] }, AUTHOR);
    await render(BundlesDashboardPage({ searchParams: Promise.resolve({}) }));
    const bundleQuery = log.find((q) => q.table === "bundles");
    expect(bundleQuery?.select).toContain("price_all");
    expect(bundleQuery?.select).not.toContain("price_cents");
    expect(bundleQuery?.filters).not.toContain("not-null:price_all");
  });

  it("editing a null-priced bundle opens an EMPTY price field -- never its legacy 2500 cents", async () => {
    install({ books: OWN_BOOKS, bundles: [UNPRICED], bundle_books: [] }, AUTHOR);
    const html = await render(
      EditBundlePage({ params: Promise.resolve({ id: String(UNPRICED.id) }), searchParams: Promise.resolve({}) }),
    );
    const input = priceInput(html);
    expect(input).toContain('type="text"');
    expect(input).toContain('inputMode="decimal"');
    expect(input).toContain('value=""');
    expect(html).not.toContain("25.00");
    expect(html).not.toContain("2500");
    expect(html).toContain("Bundle price (ALL)");
    noDollarOrUsd(html);
  });

  it("editing a priced bundle prefills its whole-lek price_all", async () => {
    install({ books: OWN_BOOKS, bundles: [PAID], bundle_books: [] }, AUTHOR);
    const html = await render(
      EditBundlePage({ params: Promise.resolve({ id: String(PAID.id) }), searchParams: Promise.resolve({}) }),
    );
    expect(priceInput(html)).toContain('value="199"');
    expect(html).not.toContain('value="0.00"');
  });

  it("the edit page never selects price_cents", async () => {
    install({ books: OWN_BOOKS, bundles: [PAID], bundle_books: [] }, AUTHOR);
    await render(
      EditBundlePage({ params: Promise.resolve({ id: String(PAID.id) }), searchParams: Promise.resolve({}) }),
    );
    const bundleQuery = log.find((q) => q.table === "bundles");
    expect(bundleQuery?.select).toContain("price_all");
    expect(bundleQuery?.select).not.toContain("price_cents");
  });
});

// ------------------------------------------------------------------
// Maintenance: every schema-sensitive bundle page still gates first.
// ------------------------------------------------------------------
describe("bundle catalog pages: first-statement maintenance gate (ALL-WIRING-5)", () => {
  beforeEach(() => {
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
    install({});
    currentClient = new Proxy({} as ReturnType<typeof makeClient>, {
      get() {
        throw new Error("SUPABASE_REACHED");
      },
    });
  });

  it.each([
    ["the bookstore", () => BookstorePage({ searchParams: Promise.resolve({}) })],
    ["an author page", () => AuthorProfilePage({ params: Promise.resolve({ id: AUTHOR }) })],
    [
      "bundle detail",
      () => BundleDetailPage({ params: Promise.resolve({ id: "x" }), searchParams: Promise.resolve({}) }),
    ],
    ["the bundle dashboard", () => BundlesDashboardPage({ searchParams: Promise.resolve({}) })],
    [
      "the bundle edit form",
      () => EditBundlePage({ params: Promise.resolve({ id: "x" }), searchParams: Promise.resolve({}) }),
    ],
  ])("%s renders the maintenance notice without touching Supabase", async (_label, page) => {
    const html = await render(page() as Promise<unknown>);
    expect(html).toContain("Scheduled maintenance");
    expect(log).toEqual([]);
  });
});
