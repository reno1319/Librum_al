import { describe, expect, it, vi } from "vitest";

// ADMIN-1A pre-finalize correction: proves this page itself calls
// requireStaff("reports.view") -- not merely admin.access -- and that a
// denial stops execution before any Supabase query runs. Mirrors the
// RedirectSignal technique already established for Server Action
// boundary tests (src/app/admin/reports/actions.test.ts).
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

const { default: AdminBookReportsPage } = await import("./page");

describe("AdminBookReportsPage", () => {
  it("calls requireStaff('reports.view') and never queries Supabase when denied", async () => {
    await expect(
      AdminBookReportsPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRequireStaff).toHaveBeenCalledWith("reports.view");
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
