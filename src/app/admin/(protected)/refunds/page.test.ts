import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ADMIN-1A pre-finalize correction: proves this page itself calls
// requireStaff("refunds.view") -- not merely admin.access -- and that a
// denial stops execution before any Supabase query runs. Mirrors
// src/app/admin/reports/page.test.ts.
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

const { default: AdminRefundsPage } = await import("./page");

describe("AdminRefundsPage", () => {
  it("calls requireStaff('refunds.view') and never queries Supabase when denied", async () => {
    await expect(AdminRefundsPage()).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRequireStaff).toHaveBeenCalledWith("refunds.view");
    expect(mockFrom).not.toHaveBeenCalled();
  });
});

// APP A EXHAUSTIVE AUDIT: this page renders refund_requests.amount_cents
// (found by the exhaustive schema-sensitive route audit, not listed in
// V3 §3's own inventory) -- proves the maintenance gate rejects before
// requireStaff() (itself a Supabase query) or any other Supabase call.
describe("AdminRefundsPage: maintenance-mode gate", () => {
  beforeEach(() => {
    mockRequireStaff.mockClear();
    mockCreateClient.mockClear();
    mockFrom.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("renders the maintenance notice and performs zero Supabase/requireStaff calls", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const element = await AdminRefundsPage();
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);

    expect(html).toContain("Scheduled maintenance");
    expect(html).toContain("temporarily unavailable for scheduled maintenance");
    expect(mockRequireStaff).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("the notice contains no refund amount or other configuration/identifier value", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const element = await AdminRefundsPage();
    const html = renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);

    expect(html).not.toMatch(/\$\d/);
    expect(html.length).toBeLessThan(600);
  });

  it("maintenance mode off (unset) preserves existing behavior -- requireStaff('refunds.view') still runs", async () => {
    vi.unstubAllEnvs();
    await expect(AdminRefundsPage()).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRequireStaff).toHaveBeenCalledWith("refunds.view");
  });
});

// ALL-TXN-CURRENCY-4 (Patch 4): every request amount on the queue is
// rendered in the currency list_refund_request_currencies() establishes
// for THAT request -- never a guessed one, never a bare `$`.
describe("AdminRefundsPage: request amounts carry their own currency (Patch 4)", () => {
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

  function request(id: string, amount: number) {
    return {
      id,
      reader_id: null,
      stripe_payment_intent_id: `pi_${id}`,
      amount_cents: amount,
      reason: null,
      status: "requested",
      requested_at: "2026-09-20T10:00:00Z",
      reviewed_at: null,
      admin_notes: null,
    };
  }

  let rpc: ReturnType<typeof vi.fn>;

  function setup(currencies: unknown[] | null, currencyError: unknown = null) {
    rpc = vi.fn(async () => ({ data: currencies, error: currencyError }));
    mockRequireStaff.mockImplementation((() => undefined) as never);
    mockCreateClient.mockImplementation((() =>
      Promise.resolve({
        from: (table: string) =>
          queryStub({
            data:
              table === "refund_requests"
                ? [request("r1", 699), request("r2", 79920), request("r3", 4200), request("r4", 5100)]
                : [],
          }),
        rpc,
      })) as never);
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
    const element = await AdminRefundsPage();
    return renderToStaticMarkup(element as Parameters<typeof renderToStaticMarkup>[0]);
  }

  it("renders each request in its own resolved currency; unknown and conflict are never given one", async () => {
    setup([
      { refund_request_id: "r1", currency_state: "resolved", currency: "USD" },
      { refund_request_id: "r2", currency_state: "resolved", currency: "ALL" },
      { refund_request_id: "r3", currency_state: "conflict", currency: null },
      // r4 is not returned at all.
    ]);
    const html = await render();
    expect(rpc).toHaveBeenCalledWith("list_refund_request_currencies", {
      p_refund_request_ids: ["r1", "r2", "r3", "r4"],
    });
    expect(html).toContain("USD 6.99");
    expect(html).toContain("799,20 ALL");
    expect(html).toContain("Amount unavailable (conflicting currency records)");
    expect(html).toContain("Amount unavailable (currency unknown)");
    expect(html).not.toContain("USD 42.00");
    expect(html).not.toContain("42,00 ALL");
    expect(html).not.toContain("USD 51.00");
    expect(html).not.toContain("51,00 ALL");
    expect(html).not.toMatch(/\$/);
  });

  it("a failed currency read degrades every amount to unavailable and keeps the queue usable", async () => {
    setup(null, { message: "boom" });
    const html = await render();
    expect(html).toContain("4 awaiting review");
    expect(html).not.toContain("USD ");
    expect(html).not.toContain(" ALL");
    expect(html.match(/Amount unavailable \(currency unknown\)/g)).toHaveLength(4);
  });
});
