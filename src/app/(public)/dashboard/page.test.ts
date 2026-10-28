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
    expect(html).toContain("Scheduled maintenance");
    expect(html).toContain("temporarily unavailable for scheduled maintenance");
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
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    mockCreateClient.mockImplementation(() => {
      throw SENTINEL;
    });
  });

  it("shows the summary, 30-day figures and 'Not scheduled yet' when every read succeeds", async () => {
    const html = await render(TABLES, RPCS);
    expect(html).toContain("Sales this month");
    expect(html).toContain("Net revenue this month");
    expect(html).toContain("Net revenue all time");
    expect(html).toContain("Not scheduled yet");
    expect(html).toContain("1 sale (30 days)");
    expect(html).toContain("0 downloads (30 days)");
    expect(html).toContain("All (3)");
    expect(html).toContain("Published (2)");
    expect(html).toContain("Drafts (1)");
    expect(html).toContain("Missing: Add a cover image");
    expect(html).not.toContain("Could not load sales data");
  });

  it("a failed sales read replaces every figure with the existing sentence and keeps the book list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const html = await render(TABLES, {
      ...RPCS,
      author_lost_disputed_payment_intents: { data: null, error: { message: "boom" } },
    });
    expect(html).toContain("Could not load sales data. Please try again.");
    expect(html).not.toContain("Sales this month");
    expect(html).not.toContain("Net revenue");
    expect(html).not.toContain("(30 days)");
    expect(html).toContain("Era e Veriut");
    expect(html).toContain("Udhetim ne Jug");
  });

  it("never shows a computed payout date while the scheduler is off", async () => {
    const html = await render(TABLES, RPCS);
    const { computeNextPayoutCycleDate, formatPayoutCycleDate } = await import("@/lib/payout-cycle");
    expect(html).not.toContain(formatPayoutCycleDate(computeNextPayoutCycleDate()));
    expect(html).toContain("Not scheduled yet");

    vi.stubEnv("PAYOUT_SCHEDULER_ENABLED", "true");
    const enabled = await render(TABLES, RPCS);
    expect(enabled).toContain(formatPayoutCycleDate(computeNextPayoutCycleDate()));
    expect(enabled).not.toContain("Not scheduled yet");
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
    expect(pending).toContain(">IN REVIEW<");
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
    expect(sentBack).not.toContain(">IN REVIEW<");
    expect(sentBack).toContain("Librum sent this book back on");
    expect(sentBack).toContain("Please fix the file.");
  });

  it("filters by tab and title search", async () => {
    const drafts = await render(TABLES, RPCS, { tab: "drafts" });
    expect(drafts).toContain("Udhetim ne Jug");
    expect(drafts).not.toContain("Era e Veriut");

    const search = await render(TABLES, RPCS, { q: "gjuha" });
    expect(search).toContain("Gjuha e Gureve");
    expect(search).not.toContain("Era e Veriut");

    const none = await render(TABLES, RPCS, { q: "zzz" });
    expect(none).toContain("No books match your search.");
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
    expect(html).toContain("Your dashboard");
    expect(html).not.toMatch(/>Hello\b/);
    expect(html).not.toContain("Manage your books, sales, and earnings.");
    expect(tablesRead).not.toContain("profiles");
  });
});
