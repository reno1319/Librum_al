import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ADMIN-1A final pre-commit correction: proves this page itself calls
// requireStaff("refunds.view") and that a denial stops execution before
// any Supabase query runs. Mirrors src/app/admin/refunds/page.test.ts and
// src/app/admin/reports/[id]/page.test.ts.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

const mockRequireStaff = vi.fn((permission: string) => {
  throw new RedirectSignal(`/?denied=${permission}`);
});
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockFrom = vi.fn();
const mockCreateClient = vi.fn(() => Promise.resolve({ from: mockFrom }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

vi.mock("next/navigation", () => ({ notFound: vi.fn() }));

const { default: AdminRefundRequestDetailPage } = await import("./page");

describe("AdminRefundRequestDetailPage", () => {
  it("calls requireStaff('refunds.view') and never queries Supabase when denied", async () => {
    await expect(
      AdminRefundRequestDetailPage({
        params: Promise.resolve({ id: "refund-1" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRequireStaff).toHaveBeenCalledWith("refunds.view");
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

// APP A EXHAUSTIVE AUDIT: this page renders refund_requests.amount_cents
// and refund_request_items.amount_cents (found by the exhaustive
// schema-sensitive route audit, not listed in V3 §3's own inventory) --
// proves the maintenance gate rejects before requireStaff() (itself a
// Supabase query) or any other Supabase call.
describe("AdminRefundRequestDetailPage: maintenance-mode gate", () => {
  const REFUND_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    mockRequireStaff.mockClear();
    mockCreateClient.mockClear();
    mockFrom.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase/requireStaff calls", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const element = await AdminRefundRequestDetailPage({
      params: Promise.resolve({ id: REFUND_ID }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);

    expect(html).toContain("Scheduled maintenance");
    expect(html).toContain("temporarily unavailable for scheduled maintenance");
    expect(mockRequireStaff).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("the notice contains no refund id, amount, or other configuration/identifier value", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const element = await AdminRefundRequestDetailPage({
      params: Promise.resolve({ id: REFUND_ID }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);

    expect(html).not.toContain(REFUND_ID);
    expect(html).not.toMatch(/\$\d/);
    expect(html.length).toBeLessThan(600);
  });

  it("maintenance mode off (unset) preserves existing behavior -- requireStaff('refunds.view') still runs", async () => {
    vi.unstubAllEnvs();
    await expect(
      AdminRefundRequestDetailPage({
        params: Promise.resolve({ id: REFUND_ID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("refunds.view");
  });
});

// ALL-TXN-CURRENCY-4 (Patch 4): the request total, every one of its
// items, and the issue-refund confirmation all use the ONE currency the
// request's own payment reference establishes. An item never gets a
// currency of its own, so parent and items cannot disagree.
describe("AdminRefundRequestDetailPage: request and items share the request's currency (Patch 4)", () => {
  const REFUND_ID = "22222222-2222-4222-8222-222222222222";

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

  function setup(currencyRows: unknown[] | null, status = "requested") {
    const rpc = vi.fn(async () => ({ data: currencyRows, error: currencyRows ? null : { message: "boom" } }));
    mockRequireStaff.mockImplementation((() => undefined) as never);
    mockCreateClient.mockImplementation((() =>
      Promise.resolve({
        from: (table: string) =>
          queryStub({
            data:
              table === "refund_requests"
                ? {
                    id: REFUND_ID,
                    reader_id: null,
                    reviewed_by: null,
                    stripe_payment_intent_id: "pi_detail",
                    amount_cents: 159840,
                    reason: null,
                    status,
                    requested_at: "2026-09-20T10:00:00Z",
                    reviewed_at: null,
                    admin_notes: null,
                  }
                : table === "refund_request_items"
                  ? [
                      { id: "i1", purchase_id: "p1", book_id: "b1", amount_cents: 79920, books: { title: "Alpha" } },
                      { id: "i2", purchase_id: "p2", book_id: "b2", amount_cents: 79920, books: { title: "Beta" } },
                    ]
                  : [],
          }),
        rpc,
      })) as never);
    return rpc;
  }

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mockRequireStaff.mockImplementation((permission: string) => {
      throw new RedirectSignal(`/?denied=${permission}`);
    });
    mockCreateClient.mockImplementation(() => Promise.resolve({ from: mockFrom }));
  });

  async function render() {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const element = await AdminRefundRequestDetailPage({
      params: Promise.resolve({ id: REFUND_ID }),
      searchParams: Promise.resolve({}),
    });
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
  }

  it("an ALL request renders its total and every item in ALL", async () => {
    const rpc = setup([{ refund_request_id: REFUND_ID, currency_state: "resolved", currency: "ALL" }]);
    const html = await render();
    expect(rpc).toHaveBeenCalledWith("list_refund_request_currencies", {
      p_refund_request_ids: [REFUND_ID],
    });
    expect(html).toContain("1.598,40 ALL");
    expect(html.match(/799,20 ALL/g)).toHaveLength(2);
    expect(html).not.toContain("USD");
    // React inlines its own form-replay script (which names `$$reactFormReplay`);
    // only the rendered markup is checked for a dollar sign.
    expect(html.replace(/<script>[\s\S]*?<\/script>/g, "")).not.toMatch(/\$/);
  });

  it("a legacy USD request renders its total and every item in USD", async () => {
    setup([{ refund_request_id: REFUND_ID, currency_state: "resolved", currency: "USD" }]);
    const html = await render();
    expect(html).toContain("USD 1,598.40");
    expect(html.match(/USD 799\.20/g)).toHaveLength(2);
    expect(html).not.toContain(" ALL");
  });

  it("an unknown currency is shown as unavailable on the total and on every item, never as USD or ALL", async () => {
    setup(null);
    const html = await render();
    expect(html.match(/Amount unavailable \(currency unknown\)/g)).toHaveLength(3);
    expect(html).not.toContain("USD");
    expect(html).not.toContain(" ALL");
    // React inlines its own form-replay script (which names `$$reactFormReplay`);
    // only the rendered markup is checked for a dollar sign.
    expect(html.replace(/<script>[\s\S]*?<\/script>/g, "")).not.toMatch(/\$/);
  });
});
