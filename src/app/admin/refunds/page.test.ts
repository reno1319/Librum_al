import { describe, expect, it, vi } from "vitest";

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
