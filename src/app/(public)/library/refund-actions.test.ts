import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ALL-CUTOVER APP-A: focused coverage of the maintenance gate added to
// both exported actions in this file -- not a general audit of refund
// business logic (which has its own coverage in refund-logic.test.ts).
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

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { requestTransactionRefund, cancelRefundRequest } = await import("./refund-actions");

describe("requestTransactionRefund / cancelRefundRequest: maintenance-mode gate", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requestTransactionRefund redirects with the maintenance message and never reaches Supabase", async () => {
    await expect(
      requestTransactionRefund("pi_123", new FormData()),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining("/account/purchases?error="),
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("cancelRefundRequest redirects with the maintenance message and never reaches Supabase", async () => {
    await expect(cancelRefundRequest("refund-1")).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining("/account/purchases?error="),
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves cancelRefundRequest's existing behavior", async () => {
    vi.unstubAllEnvs();
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: null } }) },
    });

    await expect(cancelRefundRequest("refund-1")).rejects.toMatchObject({
      target: expect.stringContaining("/login?next=/account/purchases"),
    });
    expect(mockCreateClient).toHaveBeenCalled();
  });
});
