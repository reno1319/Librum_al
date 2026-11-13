import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// APP A EXHAUSTIVE AUDIT: this is the main post-login author dashboard
// hub -- it renders books.price_cents via AuthorBookRow (found by the
// exhaustive schema-sensitive route audit, not listed in V3 §3's own
// inventory) -- this file exists solely to prove the maintenance gate
// at runtime on the single most-visited authenticated page in the app.
const SENTINEL = new Error("CREATE_CLIENT_CALLED");
const mockCreateClient = vi.fn(() => {
  throw SENTINEL;
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("@/app/(public)/dashboard/books/actions", () => ({ deleteBook: vi.fn() }));
// BD15 P6: the bookshelf reads book_pending_changes with the trusted
// writer; the fake records which ids it was asked for.
type PendingResult = { data: unknown; error: unknown };
const pendingState: { result: PendingResult; askedIds: string[][]; created: number } = {
  result: { data: [], error: null },
  askedIds: [],
  created: 0,
};
vi.mock("@/lib/catalog-write-client", () => ({
  createCatalogWriteClient: () => {
    pendingState.created += 1;
    return {
      from: (table: string) => {
        if (table !== "book_pending_changes") throw new Error(`unexpected table ${table}`);
        const builder = {
          select: () => builder,
          in: (_column: string, ids: string[]) => {
            pendingState.askedIds.push(ids);
            return builder;
          },
          returns: () => Promise.resolve(pendingState.result),
        };
        return builder;
      },
    };
  },
}));

const { default: DashboardPage } = await import("./page");

function pageArgs() {
  return { searchParams: Promise.resolve({}) };
}

describe("DashboardPage: maintenance-mode gate", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase calls", async () => {
    const element = await DashboardPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain("Mirëmbajtje e planifikuar");
    expect(html).toContain("përkohësisht i padisponueshëm për mirëmbajtje të planifikuar");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("the notice contains no book price or other configuration/identifier value", async () => {
    const element = await DashboardPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).not.toMatch(/\$\d/);
    expect(html.length).toBeLessThan(600);
  });

  it("maintenance mode off (unset) preserves existing behavior -- the page still reaches Supabase", async () => {
    vi.unstubAllEnvs();
    await expect(DashboardPage(pageArgs())).rejects.toBe(SENTINEL);
    expect(mockCreateClient).toHaveBeenCalledOnce();
  });
});

// REDESIGN STEP 4: the dashboard's sales figures fail safe, the payout
// box never shows a computed date while the scheduler is off, and the
// book list honours its tab and title search.
describe("DashboardPage: step 4 dashboard", () => {
  type Result = { data: unknown; error: unknown };
  function fakeClient(tables: Record<string, Result>, rpcs: Record<string, Result>) {
    const chain = (result: Result) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "in", "is", "eq", "not", "order"]) {
        builder[method] = () => builder;
      }
      builder.returns = () => Promise.resolve(result);
      builder.single = () => Promise.resolve(result);
      return builder;
    };
    return {
      auth: { getUser: () => Promise.resolve({ data: { user: { id: "author-1" } } }) },
      from: (table: string) => chain(tables[table] ?? { data: [], error: null }),
      rpc: (name: string) => Promise.resolve(rpcs[name] ?? { data: [], error: null }),
      storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://x/c.jpg" } }) }) },
    };
  }

  const BOOK_BASE = {
    description: "",
    keywords: "",
    cover_path: null,
    genre: "Letërsi artistike",
    published_at: "2026-10-02T10:00:00Z",
  };
  const BOOKS = [
    { ...BOOK_BASE, id: "b1", title: "Era e Veriut", status: "published", price_all: 499 },
    { ...BOOK_BASE, id: "b2", title: "Gjuha e Gureve", status: "published", price_all: 0 },
    { ...BOOK_BASE, id: "b3", title: "Udhetim ne Jug", status: "draft", price_all: null, published_at: null },
  ];
  const TABLES = {
    books: { data: BOOKS, error: null },
    // PEN-NAMES-2 [23b]: the author-only sales views.
    author_book_purchases: {
      data: [
        {
          id: "p1",
          book_id: "b1",
          amount_cents: 49900,
          created_at: new Date().toISOString(),
          stripe_checkout_session_id: "cs_1",
          stripe_payment_intent_id: "pi_1",
        },
      ],
      error: null,
    },
    author_bundle_sales: { data: [], error: null },
  };
  const RPCS = {
    list_purchase_currencies: {
      data: [{ purchase_id: "p1", currency_state: "resolved", currency: "ALL" }],
      error: null,
    },
  };

  async function render(
    tables: Record<string, Result>,
    rpcs: Record<string, Result>,
    params: Record<string, string> = {},
  ) {
    mockCreateClient.mockImplementation((() => fakeClient(tables, rpcs)) as never);
    const element = await DashboardPage({ searchParams: Promise.resolve(params) });
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("PAYOUT_SCHEDULER_ENABLED", "");
    pendingState.result = { data: [], error: null };
    pendingState.askedIds = [];
    pendingState.created = 0;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    mockCreateClient.mockImplementation(() => {
      throw SENTINEL;
    });
  });

  it("shows the summary, 30-day figures and 'Nuk është caktuar ende' when every read succeeds", async () => {
    const html = await render(TABLES, RPCS);
    expect(html).toContain("Shitje këtë muaj");
    expect(html).toContain("Të ardhurat neto këtë muaj");
    expect(html).toContain("Të ardhurat neto gjithsej");
    expect(html).toContain("Nuk është caktuar ende");
    expect(html).toContain("1 shitje (30 ditë)");
    expect(html).toContain("0 shkarkime (30 ditë)");
    expect(html).toContain(">+ Libër i ri<");
    // DC 3 (Renato 11-13, a): "+ Libër i ri" is the one main button; the
    // series page stays linked from the Mjetet boxes.
    expect(html).toContain('href="/dashboard/series"');
    expect(html).not.toContain("Seri e re");
    // DC 2: no spaced capital labels on the dashboard.
    expect(html).not.toMatch(/\buppercase\b/);
    expect(html).not.toContain('href="/dashboard/books"');
    expect(html).toContain("Për t&#x27;u bërë: Shtoni një ballinë");
    expect(html).not.toContain("Të dhënat e shitjeve nuk u ngarkuan");
  });

  it("a failed sales read replaces every figure with the existing sentence and keeps the book list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render(TABLES, {
      ...RPCS,
      author_lost_disputed_payment_intents: { data: null, error: { message: "boom" } },
    });
    expect(html).toContain("Të dhënat e shitjeve nuk u ngarkuan. Provoni përsëri.");
    expect(html).not.toContain("Shitje këtë muaj");
    expect(html).not.toContain("Të ardhurat neto");
    expect(html).not.toContain("(30 ditë)");
    expect(html).toContain("Era e Veriut");
    expect(html).toContain("Udhetim ne Jug");
  });

  it("never shows a computed payout date while the scheduler is off", async () => {
    const html = await render(TABLES, RPCS);
    const { computeNextPayoutCycleDate, formatPayoutCycleDate } = await import("@/lib/payout-cycle");
    expect(html).not.toContain(formatPayoutCycleDate(computeNextPayoutCycleDate()));
    expect(html).toContain("Nuk është caktuar ende");

    vi.stubEnv("PAYOUT_SCHEDULER_ENABLED", "true");
    const enabled = await render(TABLES, RPCS);
    expect(enabled).toContain(formatPayoutCycleDate(computeNextPayoutCycleDate()));
    expect(enabled).not.toContain("Nuk është caktuar ende");
  });

  // DR1 fix 2: empty money figures read "0 lekë", the words go small under them.
  it("shows 0 lekë with a small 'Ende pa shitje' note before the first sale, and a dash for the payout", async () => {
    const html = await render(
      { ...TABLES, author_book_purchases: { data: [], error: null } },
      { list_purchase_currencies: { data: [], error: null } },
    );
    // Phone box + two desktop cards.
    expect(html.match(/>0 lekë</g)).toHaveLength(3);
    expect(html.match(/<p class="text-\[0.8125rem\] text-muted">Ende pa shitje<\/p>/g)).toHaveLength(3);
    expect(html).toMatch(/<p aria-hidden="true" class="[^"]*font-serif[^"]*">—<\/p><p class="text-\[0.8125rem\] text-muted">Nuk është caktuar ende<\/p>/);
  });

  it("drops 'Ende pa shitje' from this month once the author has ever sold (Q3 a)", async () => {
    const old = new Date(Date.now() - 70 * 24 * 3600 * 1000).toISOString();
    const html = await render(
      {
        ...TABLES,
        author_book_purchases: {
          data: [{ ...(TABLES.author_book_purchases.data[0] as Record<string, unknown>), created_at: old }],
          error: null,
        },
      },
      RPCS,
    );
    expect(html).toContain(">0 lekë<");
    expect(html).not.toContain("Ende pa shitje");
  });

  // ADMIN-3-REVIEW (F, N9): the row's IN REVIEW tag and send-back notice
  // come from ONE read of the author's own review rows.
  it("shows In review and the send-back notice from the author's review rows", async () => {
    const reviewRow = (status: string, extra: Record<string, unknown> = {}) => ({
      book_id: "b3",
      book_title: "Udhetim ne Jug",
      author_id: "author-1",
      status,
      submitted_at: "2026-10-18T10:00:00Z",
      reason: null,
      message_to_author: null,
      decided_at: null,
      ...extra,
    });
    const pending = await render({ ...TABLES, book_reviews: { data: [reviewRow("pending")], error: null } }, RPCS);
    expect(pending).toContain("<span>Në shqyrtim</span>");
    const sentBack = await render(
      {
        ...TABLES,
        book_reviews: {
          data: [reviewRow("sent_back", { reason: "broken_file", message_to_author: "Please fix the file", decided_at: "2026-10-19T10:00:00Z" })],
          error: null,
        },
      },
      RPCS,
    );
    expect(sentBack).not.toContain("<span>Në shqyrtim</span>");
    expect(sentBack).toContain("<span>Kthyer për ndryshime</span>");
    expect(sentBack).toContain("Librum jua ktheu këtë libër për ndryshime më");
    expect(sentBack).toContain("Please fix the file.");
  });

  it("filters by state and title search", async () => {
    const drafts = await render(TABLES, RPCS, { filter: "draft" });
    expect(drafts).toContain("Udhetim ne Jug");
    expect(drafts).not.toContain("Era e Veriut");
    const live = await render(TABLES, RPCS, { filter: "live" });
    expect(live).toContain("Era e Veriut");
    // (The draft is still named in the "continue your draft" alert.)
    expect(live).not.toContain(">Udhetim ne Jug<");

    const search = await render(TABLES, RPCS, { q: "gjuha" });
    expect(search).toContain("Gjuha e Gureve");
    expect(search).not.toContain("Era e Veriut");

    const none = await render(TABLES, RPCS, { q: "zzz" });
    expect(none).toContain("Asnjë libër nuk përputhet me kërkimin.");
  });

  // ------------------------------------------------------------
  // BD15 P6: the bookshelf.
  // ------------------------------------------------------------
  const order = (html: string, titles: string[]) => titles.map((title) => html.indexOf(`>${title}<`));

  it("asks the trusted writer only for the author's own LIVE book ids", async () => {
    await render(TABLES, RPCS);
    expect(pendingState.askedIds).toEqual([["b1", "b2"]]);
  });

  // Audit r1 T1: books RLS also lets a buyer read a book they bought, so
  // the author_id filter is what keeps other authors' books (and their ids)
  // out of the shelf and out of the trusted read.
  it("reads books and series filtered to the signed-in author's own id", async () => {
    const filters: [string, string, unknown][] = [];
    const client = {
      auth: { getUser: () => Promise.resolve({ data: { user: { id: "author-1" } } }) },
      from: (table: string) => {
        const result = table === "books" ? { data: BOOKS.map((b) => ({ ...b, series_id: "s1" })), error: null } : { data: [], error: null };
        const builder: Record<string, unknown> = {};
        for (const method of ["select", "in", "is", "not", "order"]) builder[method] = () => builder;
        builder.eq = (column: string, value: unknown) => {
          filters.push([table, column, value]);
          return builder;
        };
        builder.returns = () => Promise.resolve(result);
        builder.single = () => Promise.resolve(result);
        return builder;
      },
      rpc: (name: string) => Promise.resolve((RPCS as Record<string, Result>)[name] ?? { data: [], error: null }),
      storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://x/c.jpg" } }) }) },
    };
    mockCreateClient.mockImplementation((() => client) as never);
    await DashboardPage({ searchParams: Promise.resolve({}) });
    expect(filters).toContainEqual(["books", "author_id", "author-1"]);
    expect(filters).toContainEqual(["series", "author_id", "author-1"]);
  });

  it("never creates the trusted writer when no book is live", async () => {
    await render({ ...TABLES, books: { data: [BOOKS[2]], error: null } }, RPCS);
    expect(pendingState.created).toBe(0);
  });

  it("a live book with waiting changes: its state, the readers line and Vazhdoni ndryshimet", async () => {
    pendingState.result = {
      data: [
        {
          book_id: "b1",
          file_path: null,
          cover_path: null,
          description: "A new description",
          is_adult: false,
          original_author: null,
          created_at: "2026-11-01T10:00:00Z",
        },
      ],
      error: null,
    };
    const html = await render(TABLES, RPCS);
    expect(html).toContain(">Publikuar, me ndryshime të padërguara<");
    expect(html).toContain("Lexuesit shohin ende versionin e vjetër derisa ndryshimet të miratohen.");
    expect(html).toContain(">Vazhdoni ndryshimet<");
    expect(html).toContain(">Hidhni poshtë ndryshimet<");
    const changes = await render(TABLES, RPCS, { filter: "changes" });
    expect(changes).toContain("Era e Veriut");
    expect(changes).not.toContain("Gjuha e Gureve");
  });

  it("a waiting row equal to the live book is not 'changes'", async () => {
    pendingState.result = {
      data: [
        { book_id: "b1", file_path: null, cover_path: null, description: "", is_adult: false, original_author: null, created_at: "2026-11-01T10:00:00Z" },
      ],
      error: null,
    };
    const html = await render(TABLES, RPCS);
    expect(html).not.toContain("me ndryshime të padërguara");
  });

  it("a live send back shows while the changes it was about still wait, not after newer ones", async () => {
    const sentBackRows = {
      data: [
        {
          book_id: "b1",
          book_title: "Era e Veriut",
          author_id: "author-1",
          status: "sent_back",
          submitted_at: "2026-11-01T12:00:00Z",
          reason: "broken_file",
          message_to_author: "Fix the file",
          decided_at: "2026-11-02T10:00:00Z",
        },
      ],
      error: null,
    };
    const waiting = (createdAt: string) => ({
      data: [
        { book_id: "b1", file_path: "new.epub", cover_path: null, description: "", is_adult: false, original_author: null, created_at: createdAt },
      ],
      error: null,
    });
    pendingState.result = waiting("2026-11-01T10:00:00Z");
    const about = await render({ ...TABLES, book_reviews: sentBackRows }, RPCS);
    expect(about).toContain("<span>Publikuar, ndryshimet u kthyen</span>");
    expect(about).toContain("Librum jua ktheu ndryshimet më");

    pendingState.result = waiting("2026-11-03T10:00:00Z");
    const newer = await render({ ...TABLES, book_reviews: sentBackRows }, RPCS);
    expect(newer).toContain("<span>Publikuar, me ndryshime të padërguara</span>");
    expect(newer).not.toContain("Librum jua ktheu");
  });

  it("a taken-down book is its own state and filter", async () => {
    const tables = {
      ...TABLES,
      book_takedowns: {
        data: [
          {
            book_id: "b3",
            taken_down_at: "2026-10-19T10:00:00Z",
            reason: "content_rules",
            message_to_author: "x",
            bundle_ids: [],
          },
        ],
        error: null,
      },
    };
    const html = await render(tables, RPCS, { filter: "taken_down" });
    expect(html).toContain("<span>Hequr nga Libraria</span>");
    expect(html).toContain(">Udhetim ne Jug<");
    expect(html).not.toContain(">Era e Veriut<");
  });

  it("a failed waiting-changes read shows a visible line and the books as live", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    pendingState.result = { data: null, error: { code: "42501" } };
    const html = await render(TABLES, RPCS);
    expect(html).toContain("Nuk mundëm të kontrollojmë ndryshimet e papublikuara të librave live. Rifreskoni faqen.");
    expect(html).toContain("Era e Veriut");
  });

  it("a live book's main button is its book page, and it has no Delete", async () => {
    const html = await render({ ...TABLES, books: { data: [BOOKS[0]], error: null } }, RPCS);
    expect(html).toMatch(/href="\/libra\/b1"[^>]*>Shikoni faqen e librit</);
    expect(html).not.toContain(">Fshini<");
    expect(html).toContain(">Hiqeni nga shitja<");
  });

  it("sorts newest first by default, by title, and by publish date with drafts last", async () => {
    const books = [
      { ...BOOK_BASE, id: "b1", title: "Beta", status: "published", price_all: 0, created_at: "2026-10-01T00:00:00Z", published_at: "2026-10-05T00:00:00Z" },
      { ...BOOK_BASE, id: "b2", title: "Alfa", status: "published", price_all: 0, created_at: "2026-09-01T00:00:00Z", published_at: "2026-10-20T00:00:00Z" },
      { ...BOOK_BASE, id: "b3", title: "Gama", status: "draft", price_all: null, created_at: "2026-11-01T00:00:00Z", published_at: null },
    ];
    const tables = { ...TABLES, books: { data: books, error: null } };
    const isAscending = (at: number[]) => at.every((i) => i > -1) && at.every((i, n) => n === 0 || i > at[n - 1]);
    expect(isAscending(order(await render(tables, RPCS), ["Gama", "Beta", "Alfa"]))).toBe(true);
    expect(isAscending(order(await render(tables, RPCS, { sort: "az" }), ["Alfa", "Beta", "Gama"]))).toBe(true);
    expect(isAscending(order(await render(tables, RPCS, { sort: "pub" }), ["Alfa", "Beta", "Gama"]))).toBe(true);
  });

  it("groups by series in reading order, or shows a flat list with the series on the card", async () => {
    const books = [
      { ...BOOK_BASE, id: "b1", title: "Libri dy", status: "draft", price_all: null, series_id: "s1", series_position: 2, created_at: "2026-10-03T00:00:00Z" },
      { ...BOOK_BASE, id: "b2", title: "Libri nje", status: "draft", price_all: null, series_id: "s1", series_position: 1, created_at: "2026-10-01T00:00:00Z" },
      { ...BOOK_BASE, id: "b3", title: "Pa seri", status: "draft", price_all: null, series_id: null, series_position: null, created_at: "2026-10-02T00:00:00Z" },
    ];
    const tables = {
      ...TABLES,
      books: { data: books, error: null },
      series: { data: [{ id: "s1", title: "Kronikat" }], error: null },
    };
    const grouped = await render(tables, RPCS);
    expect(grouped).toContain('aria-label="Seria Kronikat"');
    expect(grouped).toContain(">Libra më vete<");
    const at = order(grouped, ["Libri nje", "Libri dy", "Pa seri"]);
    expect(at.every((i, n) => i > -1 && (n === 0 || i > at[n - 1]))).toBe(true);
    expect(grouped).toContain(">Libri 1<");

    const flat = await render(tables, RPCS, { view: "flat" });
    expect(flat).not.toContain(">Libra më vete<");
    expect(flat).toContain(">Kronikat · Libri 2<");
  });

  it("a failed series read shows a visible line and the books outside a series", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const books = [
      { ...BOOK_BASE, id: "b1", title: "Libri dy", status: "draft", price_all: null, series_id: "s1", series_position: 2 },
    ];
    const html = await render(
      { ...TABLES, books: { data: books, error: null }, series: { data: null, error: { code: "42501" } } },
      RPCS,
    );
    expect(html).toContain("Emrat e serive nuk u ngarkuan. Rifreskoni faqen.");
    expect(html).toContain("Libri dy");
  });

  // DC 4 (Renato 11-13, a): on a phone the toolbar folds under one line.
  it("folds the phone toolbar, closed by default and open while a choice is active", async () => {
    const closed = await render(TABLES, RPCS);
    const fold = closed.match(/<details[^>]*md:hidden[^>]*>/);
    expect(fold).not.toBeNull();
    expect(fold![0]).not.toContain(" open");
    expect(closed).toContain("Rendit, filtro, kërko");
    // Two forms with their own ids: the phone copy and the computer row.
    expect(closed.match(/role="search"/g)).toHaveLength(2);
    expect(closed).toContain('id="phone-dashboard-book-search"');
    expect(closed).toContain('id="dashboard-book-search"');
    expect(closed).toMatch(/<form role="search" class="hidden [^"]*md:grid/);

    const searched = await render(TABLES, RPCS, { q: "Era" });
    expect(searched.match(/<details[^>]*md:hidden[^>]*>/)![0]).toContain(" open");
  });

  it("the toolbar is a plain GET form that keeps the chosen values", async () => {
    const html = await render(TABLES, RPCS, { sort: "az", filter: "draft", view: "flat", q: "jug" });
    expect(html).toMatch(/<form role="search"[^>]*action="\/dashboard" method="get">/);
    expect(html).toMatch(/<option value="az" selected="">Titulli A–Z</);
    expect(html).toMatch(/<option value="draft" selected="">Draft</);
    expect(html).toMatch(/<option value="flat" selected="">Lista e thjeshtë</);
    expect(html).toContain('value="jug"');
    // Unknown values fall back to the defaults.
    const odd = await render(TABLES, RPCS, { sort: "zzz", filter: "<x>", view: "?" });
    expect(odd).toMatch(/<option value="new" selected="">Më të rejat</);
    expect(odd).toMatch(/<option value="all" selected="">Të gjitha</);
  });
});

// HEADER-NAME r2 (Renato 11:52Z): the greeting lives in the site header
// only; the Dashboard shows neither a greeting nor the old grey line, and
// reads no profiles row.
describe("DashboardPage: no greeting line (HEADER-NAME r2)", () => {
  it("renders the heading alone and never reads profiles", async () => {
    const tablesRead: string[] = [];
    const chain = () => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "in", "is", "eq", "not", "order"]) builder[method] = () => builder;
      builder.returns = () => Promise.resolve({ data: [], error: null });
      builder.single = () => Promise.resolve({ data: { display_name: "Renato Kalemi" }, error: null });
      return builder;
    };
    mockCreateClient.mockImplementation((() => ({
      auth: { getUser: () => Promise.resolve({ data: { user: { id: "author-1", email: "r@example.com" } } }) },
      from: (table: string) => {
        tablesRead.push(table);
        return chain();
      },
      rpc: () => Promise.resolve({ data: [], error: null }),
      storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "https://x/c.jpg" } }) }) },
    })) as never);
    const element = await DashboardPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain("Paneli juaj");
    expect(html).not.toMatch(/>Hello\b/);
    expect(html).not.toContain("Manage your books, sales, and earnings.");
    expect(tablesRead).not.toContain("profiles");
  });
});
