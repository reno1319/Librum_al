import { describe, expect, it, vi } from "vitest";

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
