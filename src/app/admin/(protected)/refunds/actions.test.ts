import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ALL-CUTOVER APP-A: the maintenance-mode gate on reviewRefundRequest.
// STRIPE REMOVAL (pipeline item 10): issueStripeRefund and its Stripe
// refund executor are gone; this module now exports the review action
// only.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Wrapped in its own named spy (not an inline vi.fn() inside the mock
// factory) so the gate test below can assert requireStaff() is never
// even reached.
const mockRequireStaff = vi.fn((_permission: string) =>
  Promise.resolve({ userId: "admin-1", role: "admin" }),
);
vi.mock("@/lib/staff", () => ({
  requireStaff: (permission: string) => mockRequireStaff(permission),
}));

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const actions = await import("./actions");

describe("reviewRefundRequest: maintenance-mode gate (APP A CORRECTION 2)", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRequireStaff.mockClear();
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("redirects with the maintenance message before requireStaff() or any Supabase call", async () => {
    await expect(
      actions.reviewRefundRequest("refund-request-1", "approved", new FormData()),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/admin/refunds?error="));
    expect(mockRequireStaff).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });
});

describe("refund actions after Stripe removal", () => {
  it("exports the review action only: no refund can be issued from here", () => {
    expect(Object.keys(actions).sort()).toEqual(["reviewRefundRequest"]);
  });
});
