import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// ALL-CUTOVER APP-A: focused coverage of the maintenance gate on this
// schema-sensitive dashboard sales page (V3 §3) -- not a general audit
// of Sales' own revenue-computation logic (covered separately by
// revenue-logic.test.ts).
const SENTINEL = new Error("CREATE_CLIENT_CALLED");
const mockCreateClient = vi.fn(() => {
  throw SENTINEL;
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { default: SalesPage } = await import("./page");

describe("SalesPage: maintenance-mode gate", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase calls", async () => {
    const element = await SalesPage();
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain("Scheduled maintenance");
    expect(html).toContain("temporarily unavailable for scheduled maintenance");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("the notice contains no revenue figure or other configuration/identifier value", async () => {
    const element = await SalesPage();
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).not.toMatch(/\$\d/);
    expect(html.length).toBeLessThan(600);
  });

  it("maintenance mode off (unset) preserves existing behavior -- the page still reaches Supabase", async () => {
    vi.unstubAllEnvs();
    await expect(SalesPage()).rejects.toBe(SENTINEL);
    expect(mockCreateClient).toHaveBeenCalledOnce();
  });
});

// ALL-TXN-CURRENCY-4 (Patch 4): rendered coverage of every money figure
// on the Sales page, with a stubbed Supabase client and
// renderToStaticMarkup -- no DOM dependency.
function queryStub(result: unknown) {
  const chain: Record<string, unknown> = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return (resolve: (v: unknown) => unknown) => resolve(result);
        return () => chain;
      },
    },
  );
  return chain;
}

type SalesFixture = {
  books: { id: string; title: string; status: string }[];
  purchases: unknown[];
  snapshots?: unknown[];
  lostDisputed?: string[];
  currencies?: { purchase_id: string; currency_state: string; currency: string | null }[];
  currencyError?: unknown;
};

async function renderSales(fixture: SalesFixture) {
  const rpc = vi.fn(async (fn: string, args?: unknown) => {
    if (fn === "author_lost_disputed_payment_intents") {
      return {
        data: (fixture.lostDisputed ?? []).map((id) => ({ stripe_payment_intent_id: id })),
        error: null,
      };
    }
    if (fn === "list_purchase_currencies") {
      return fixture.currencyError
        ? { data: null, error: fixture.currencyError }
        : { data: fixture.currencies ?? [], error: null };
    }
    throw new Error(`unexpected rpc ${fn} ${JSON.stringify(args)}`);
  });
  mockCreateClient.mockImplementation((() => ({
    auth: { getUser: async () => ({ data: { user: { id: "author-1" } } }) },
    rpc,
    from: (table: string) =>
      queryStub({
        data:
          table === "books"
            ? fixture.books
            : table === "purchases"
              ? fixture.purchases
              : table === "bundle_checkout_snapshots"
                ? (fixture.snapshots ?? [])
                : [],
      }),
  })) as never);
  const element = await SalesPage();
  return { html: renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]), rpc };
}

const TODAY = new Date();
TODAY.setHours(12, 0, 0, 0);
const AT_TODAY = TODAY.toISOString();

function sale(id: string, bookId: string, amount: number, pi: string | null, session: string | null = null) {
  return {
    id,
    book_id: bookId,
    amount_cents: amount,
    created_at: AT_TODAY,
    stripe_checkout_session_id: session,
    stripe_payment_intent_id: pi,
  };
}

const BOOKS = [
  { id: "b1", title: "Alpha", status: "published" },
  { id: "b2", title: "Beta", status: "published" },
];

describe("SalesPage: transaction currency (Patch 4)", () => {
  beforeEach(() => {
    mockCreateClient.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("splits net revenue and the daily chart by currency; never a combined figure, never a bare $", async () => {
    // Platform fee is 20%: 1000 USD cents -> 800 net; 150000 ALL minor -> 120000 net.
    const { html, rpc } = await renderSales({
      books: BOOKS,
      purchases: [sale("p1", "b1", 1000, "pi_legacy"), sale("p2", "b2", 150000, "pok_new")],
      currencies: [
        { purchase_id: "p1", currency_state: "resolved", currency: "USD" },
        { purchase_id: "p2", currency_state: "resolved", currency: "ALL" },
      ],
    });
    expect(rpc).toHaveBeenCalledWith("list_purchase_currencies", { p_purchase_ids: ["p1", "p2"] });
    expect(html).toContain("1.200,00 ALL");
    expect(html).toContain("USD 8.00");
    // A cross-currency sum (800 + 120000 minor units) appears nowhere.
    expect(html).not.toContain("1.208,00");
    expect(html).not.toContain("USD 1,208.00");
    // One chart per currency.
    expect(html).toContain(">ALL</h3>");
    expect(html).toContain(">USD</h3>");
    expect(html).not.toMatch(/\$/);
  });

  it("a sale whose currency is unknown is counted as a unit but kept out of every money figure", async () => {
    const { html } = await renderSales({
      books: BOOKS,
      purchases: [sale("p1", "b1", 1000, "pi_legacy"), sale("p2", "b1", 5000, "pi_mystery")],
      currencies: [
        { purchase_id: "p1", currency_state: "resolved", currency: "USD" },
        { purchase_id: "p2", currency_state: "unknown", currency: null },
      ],
    });
    expect(html).toContain("USD 8.00");
    expect(html).not.toContain("USD 48.00");
    expect(html).not.toContain("40,00 ALL");
    expect(html).toContain("1 sale is not included: its currency could not be determined.");
    expect(html).toContain("+ 1 with unknown currency");
    // Units still count both books acquired.
    expect(html).toMatch(/Units<\/p><p[^>]*>2<\/p>/);
  });

  it("a row the RPC did not return is unknown, not USD or ALL", async () => {
    const { html } = await renderSales({
      books: BOOKS,
      purchases: [sale("p1", "b1", 1000, "pi_legacy")],
      currencies: [],
    });
    expect(html).not.toContain("USD");
    expect(html).not.toContain(" ALL");
    expect(html).toContain("No sales yet");
    expect(html).toContain("1 sale is not included");
  });

  it("a failed currency read throws instead of rendering guessed totals", async () => {
    await expect(
      renderSales({
        books: BOOKS,
        purchases: [sale("p1", "b1", 1000, "pi_legacy")],
        currencyError: { message: "boom" },
      }),
    ).rejects.toThrow("Could not load sales data. Please try again.");
  });

  it("lost-disputed sales stay excluded from the currency totals", async () => {
    const { html } = await renderSales({
      books: BOOKS,
      purchases: [sale("p1", "b1", 1000, "pi_ok"), sale("p2", "b1", 2000, "pi_lost")],
      lostDisputed: ["pi_lost"],
      currencies: [
        { purchase_id: "p1", currency_state: "resolved", currency: "USD" },
        { purchase_id: "p2", currency_state: "resolved", currency: "USD" },
      ],
    });
    expect(html).toContain("USD 8.00");
    expect(html).not.toContain("USD 24.00");
    expect(html).toMatch(/Units<\/p><p[^>]*>1<\/p>/);
  });

  it("a transaction-only bundle snapshot lands in its own frozen currency; a represented one is not added again", async () => {
    const { html } = await renderSales({
      books: BOOKS,
      purchases: [sale("p1", "b1", 1000, "pi_bundle", "cs_bundle")],
      currencies: [{ purchase_id: "p1", currency_state: "resolved", currency: "USD" }],
      snapshots: [
        // Represented by p1: must not be counted twice.
        {
          stripe_checkout_session_id: "cs_bundle",
          stripe_payment_intent_id: "pi_bundle",
          total_amount_cents: 1000,
          fulfilled_at: AT_TODAY,
          currency: "USD",
        },
        // Zero-eligible-item snapshot, frozen in ALL.
        {
          stripe_checkout_session_id: "cs_only",
          stripe_payment_intent_id: "pok_only",
          total_amount_cents: 50000,
          fulfilled_at: AT_TODAY,
          currency: "ALL",
        },
      ],
    });
    expect(html).toContain("USD 8.00");
    expect(html).not.toContain("USD 16.00");
    expect(html).toContain("400,00 ALL");
  });

  it("an author with no sales sees the empty state and one empty chart", async () => {
    const { html, rpc } = await renderSales({ books: BOOKS, purchases: [] });
    expect(html).toContain("No sales yet");
    expect(rpc).not.toHaveBeenCalledWith("list_purchase_currencies", expect.anything());
    expect(html).not.toContain("<h3");
  });
});
