import { describe, expect, it, vi, beforeEach } from "vitest";

// LIBRUM 2.0 ADMIN-1A: Server-Action-boundary coverage for
// reviewRefundRequest(), mirroring src/app/admin/reports/actions.test.ts's
// structure exactly -- kept as its own file, separate from actions.test.ts
// (which covers only issueStripeRefund's recovery-guard behavior), so
// each file's mocking setup stays narrowly scoped to what it actually
// tests. requireStaff() is mocked directly rather than re-testing
// decideStaffAccess() itself (already covered by src/lib/staff.test.ts).
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

const mockRequireStaff = vi.fn();
vi.mock("@/lib/staff", () => ({ requireStaff: (permission: string) => mockRequireStaff(permission) }));

const mockRpc = vi.fn();
const mockCreateClient = vi.fn(() => Promise.resolve({ rpc: mockRpc }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

// issueStripeRefund is also exported from this module -- unused here, but
// importing the module still evaluates its top-level Stripe/recovery-guard
// imports, so those are mocked too, purely so the import doesn't fail.
vi.mock("@/lib/stripe", () => ({ stripe: {} }));
vi.mock("@/lib/recovery-guard", () => ({ redirectIfRecoverySessionActive: vi.fn() }));

const { reviewRefundRequest } = await import("./actions");

describe("reviewRefundRequest", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockRequireStaff.mockReset();
    mockRpc.mockReset();
  });

  it("unauthenticated: requireStaff's own redirect propagates, the RPC is never called", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/login");
    });

    await expect(
      reviewRefundRequest("refund-1", "approved", new FormData()),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("staff without refunds.resolve (e.g. moderator, or support with only refunds.view): requireStaff's own redirect propagates, the RPC is never called", async () => {
    mockRequireStaff.mockImplementation(() => {
      throw new RedirectSignal("/");
    });

    await expect(
      reviewRefundRequest("refund-1", "approved", new FormData()),
    ).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockRequireStaff).toHaveBeenCalledWith("refunds.resolve");
  });

  it("staff with refunds.resolve, approves: calls review_refund_request with decision 'approved' and redirects with a success message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });
    mockRpc.mockResolvedValue({ error: null });

    await expect(
      reviewRefundRequest("refund-1", "approved", new FormData()),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRpc).toHaveBeenCalledWith("review_refund_request", {
      p_id: "refund-1",
      p_decision: "approved",
      p_admin_notes: null,
    });
    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("Refund request approved.")),
    );
  });

  it("staff with refunds.resolve, rejects: calls review_refund_request with decision 'rejected' and redirects with a success message", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });
    mockRpc.mockResolvedValue({ error: null });

    await expect(
      reviewRefundRequest("refund-1", "rejected", new FormData()),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRpc).toHaveBeenCalledWith("review_refund_request", {
      p_id: "refund-1",
      p_decision: "rejected",
      p_admin_notes: null,
    });
    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining(encodeURIComponent("Refund request rejected.")),
    );
  });

  it("RPC 'not authenticated' (defense-in-depth path) redirects to login rather than showing a generic error", async () => {
    mockRequireStaff.mockResolvedValue({ userId: "admin-1", role: "admin" });
    mockRpc.mockResolvedValue({ error: { message: "not authenticated" } });

    await expect(
      reviewRefundRequest("refund-1", "approved", new FormData()),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/login"));
  });
});
