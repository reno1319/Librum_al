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
