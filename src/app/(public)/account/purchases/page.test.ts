import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// APP A EXHAUSTIVE AUDIT: the reader purchase-history page -- reads
// purchases.amount_cents and bundle_checkout_snapshots.
// total_amount_cents directly (found by the exhaustive schema-sensitive
// route audit, not listed in V3 §3's own inventory) -- this file exists
// solely to prove the maintenance gate at runtime.
const SENTINEL = new Error("CREATE_CLIENT_CALLED");
const mockCreateClient = vi.fn(() => {
  throw SENTINEL;
});
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
vi.mock("@/app/(public)/library/refund-actions", () => ({
  requestTransactionRefund: vi.fn(), cancelRefundRequest: vi.fn(),
}));

const { default: AccountPurchasesPage } = await import("./page");

function pageArgs() {
  return { searchParams: Promise.resolve({}) };
}

describe("AccountPurchasesPage: maintenance-mode gate", () => {
  beforeEach(() => {
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase calls", async () => {
    const element = await AccountPurchasesPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).toContain("Scheduled maintenance");
    expect(html).toContain("temporarily unavailable for scheduled maintenance");
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("the notice contains no purchase amount, payment intent id, or other configuration/identifier value", async () => {
    const element = await AccountPurchasesPage(pageArgs());
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
    expect(html).not.toMatch(/\$\d/);
    expect(html.length).toBeLessThan(600);
  });

  it("maintenance mode off (unset) preserves existing behavior -- the page still reaches Supabase", async () => {
    vi.unstubAllEnvs();
    await expect(AccountPurchasesPage(pageArgs())).rejects.toBe(SENTINEL);
    expect(mockCreateClient).toHaveBeenCalledOnce();
  });
});

// ALL-TXN-CURRENCY-4 (Patch 4): rendered coverage of every monetary
// figure on the reader's purchase history, with a stubbed Supabase client
// and renderToStaticMarkup -- no DOM dependency.
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

type Fixture = {
  purchases: unknown[];
  snapshots?: unknown[];
  refundRequests?: unknown[];
  currencies?: unknown[] | null;
  currencyError?: unknown;
};

function purchaseRow(id: string, bookId: string, amount: number, pi: string | null, createdAt: string) {
  return {
    id,
    book_id: bookId,
    amount_cents: amount,
    created_at: createdAt,
    refunded_at: null,
    stripe_payment_intent_id: pi,
    books: { id: bookId, title: `Title ${bookId}` },
  };
}

async function renderPurchases(fixture: Fixture) {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "list_purchase_currencies") {
      return { data: fixture.currencyError ? null : (fixture.currencies ?? []), error: fixture.currencyError ?? null };
    }
    if (fn === "user_owns_book") return { data: true, error: null };
    throw new Error(`unexpected rpc ${fn}`);
  });
  mockCreateClient.mockImplementation((() => ({
    auth: { getUser: async () => ({ data: { user: { id: "reader-1" } } }) },
    rpc,
    from: (table: string) =>
      queryStub({
        data:
          table === "purchases"
            ? fixture.purchases
            : table === "bundle_checkout_snapshots"
              ? (fixture.snapshots ?? [])
              : table === "refund_requests"
                ? (fixture.refundRequests ?? [])
                : [],
      }),
  })) as never);
  const element = await AccountPurchasesPage(pageArgs());
  return { html: renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]), rpc };
}

const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
const OLDER = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

describe("AccountPurchasesPage: transaction currency (Patch 4)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    mockCreateClient.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("a legacy USD purchase renders as USD", async () => {
    const { html, rpc } = await renderPurchases({
      purchases: [purchaseRow("p1", "b1", 999, "pi_legacy", RECENT)],
      currencies: [{ purchase_id: "p1", currency_state: "resolved", currency: "USD" }],
    });
    expect(rpc).toHaveBeenCalledWith("list_purchase_currencies", { p_purchase_ids: ["p1"] });
    expect(html).toContain("· USD 9.99");
    expect(html).toContain('Total spent: <span><span class="font-semibold text-primary">USD 9.99</span></span>');
    expect(html).not.toContain("9,99 ALL");
    expect(html).not.toMatch(/\$\d/);
  });

  it("a new ALL purchase renders as ALL, with the qindarka", async () => {
    const { html } = await renderPurchases({
      purchases: [purchaseRow("p2", "b2", 17910, "pok_order_1", RECENT)],
      currencies: [{ purchase_id: "p2", currency_state: "resolved", currency: "ALL" }],
    });
    expect(html).toContain("· 179,10 ALL");
    expect(html).not.toContain("USD 179.10");
    expect(html).not.toMatch(/\$\d/);
  });

  it("a mixed history keeps each row's currency and shows one total per currency", async () => {
    const { html } = await renderPurchases({
      purchases: [
        purchaseRow("p1", "b1", 999, "pi_legacy", OLDER),
        purchaseRow("p2", "b2", 17910, "pok_order_1", RECENT),
      ],
      currencies: [
        { purchase_id: "p1", currency_state: "resolved", currency: "USD" },
        { purchase_id: "p2", currency_state: "resolved", currency: "ALL" },
      ],
    });
    expect(html).toContain("· USD 9.99");
    expect(html).toContain("· 179,10 ALL");
    // Totals: ALL then USD, separate, never summed (999 + 17910 = 18909).
    expect(html).toMatch(/179,10 ALL<\/span><\/span><span> · <span class="font-semibold text-primary">USD 9.99/);
    expect(html).not.toMatch(/189[.,]09/);
    expect(html).not.toMatch(/\$\d/);
  });

  it("an ambiguous purchase is not presented as USD or ALL, and is left out of the totals", async () => {
    const { html } = await renderPurchases({
      purchases: [
        purchaseRow("p1", "b1", 999, "pi_legacy", OLDER),
        purchaseRow("p3", "b3", 4242, "pi_mystery", RECENT),
      ],
      currencies: [
        { purchase_id: "p1", currency_state: "resolved", currency: "USD" },
        { purchase_id: "p3", currency_state: "unknown", currency: null },
      ],
    });
    expect(html).toContain("Amount unavailable (currency unknown)");
    expect(html).not.toMatch(/42[.,]42/);
    expect(html).toContain("1 purchase is not included because its currency could not be determined.");
    expect(html).not.toMatch(/\$\d/);
  });

  it("a conflicting purchase shows the conflict, never a picked currency", async () => {
    const { html } = await renderPurchases({
      purchases: [purchaseRow("p5", "b5", 1234, "pi_conflict", RECENT)],
      currencies: [{ purchase_id: "p5", currency_state: "conflict", currency: null }],
    });
    expect(html).toContain("Amount unavailable (conflicting currency records)");
    expect(html).not.toMatch(/12[.,]34/);
  });

  it("a failed currency read degrades every amount to unavailable -- it never defaults to USD", async () => {
    const { html } = await renderPurchases({
      purchases: [purchaseRow("p1", "b1", 999, "pi_legacy", RECENT)],
      currencyError: { message: "function list_purchase_currencies does not exist" },
    });
    expect(html).toContain("Amount unavailable (currency unknown)");
    expect(html).not.toContain("USD 9.99");
    expect(html).not.toMatch(/\$\d/);
    // The rest of the page still works.
    expect(html).toContain("Download EPUB");
  });

  it("a free acquisition reads Free and adds nothing to any total", async () => {
    const { html } = await renderPurchases({
      purchases: [purchaseRow("p4", "b4", 0, null, RECENT)],
      currencies: [{ purchase_id: "p4", currency_state: "free", currency: null }],
    });
    expect(html).toContain("· Free");
    expect(html).toContain("Total spent: nothing yet");
  });

  it("a bundle transaction's total uses the snapshot's own frozen currency", async () => {
    const { html } = await renderPurchases({
      purchases: [
        purchaseRow("p6", "b6", 500, "pi_bundle", RECENT),
        purchaseRow("p7", "b7", 700, "pi_bundle", RECENT),
      ],
      snapshots: [
        {
          id: "s1",
          stripe_payment_intent_id: "pi_bundle",
          total_amount_cents: 1200,
          fulfilled_at: RECENT,
          refunded_at: null,
          items: [
            { book_id: "b6", title: "Title b6", price_cents_at_checkout: 500 },
            { book_id: "b7", title: "Title b7", price_cents_at_checkout: 700 },
          ],
          currency: "ALL",
        },
      ],
      currencies: [
        { purchase_id: "p6", currency_state: "resolved", currency: "ALL" },
        { purchase_id: "p7", currency_state: "resolved", currency: "ALL" },
      ],
    });
    expect(html).toContain("One purchase · 2 books · 12,00 ALL");
    // Counted once, at the snapshot total -- not 24,00 ALL.
    expect(html).not.toContain("24,00 ALL");
    expect(html).not.toMatch(/\$\d/);
  });
});
