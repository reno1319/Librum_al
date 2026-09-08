import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// LAUNCH-1 P1-11: minimal, focused coverage of ONLY the new recovery
// guard added to issueStripeRefund -- see buyBook's equivalent test
// (src/app/books/[id]/actions.test.ts) for the full rationale.
// requireStaff() is mocked to always succeed so this test isolates the
// recovery guard specifically -- proving the invariant applies even to a
// staff member's own account, not conflating it with staff-authorization
// testing (already covered separately by src/lib/staff.test.ts).
// ADMIN-1A: mock updated from @/lib/auth's requireAdmin() to
// @/lib/staff's requireStaff().
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

vi.mock("@/lib/staff", () => ({
  requireStaff: vi.fn(() => Promise.resolve({ userId: "admin-1", role: "admin" })),
}));

const mockCookieStore = {
  get: vi.fn((name: string) => (name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined)),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockRefundsCreate = vi.fn();
vi.mock("@/lib/stripe", () => ({ stripe: { refunds: { create: mockRefundsCreate } } }));
const mockExecuteApprovedRefund = vi.fn();
vi.mock("./issue-refund", () => ({ executeApprovedRefund: () => mockExecuteApprovedRefund() }));

const { issueStripeRefund } = await import("./actions");

describe("issueStripeRefund: recovery-session defense-in-depth", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    mockRefundsCreate.mockClear();
    mockExecuteApprovedRefund.mockClear();
  });

  it("redirects to /reset-password and never reaches executeApprovedRefund/Stripe when the admin's own session is recovery-restricted", async () => {
    await expect(issueStripeRefund("refund-request-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockExecuteApprovedRefund).not.toHaveBeenCalled();
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });
});

// STRIPE-CUTOVER-2A Section 24: proves issueStripeRefund's own outcome
// switch handles the new "ledger_v1_not_supported" case with a
// development-safe, honest redirect message -- never the generic
// Stripe-failure wording (Stripe was never called for this outcome).
describe("issueStripeRefund: ledger_v1_not_supported outcome", () => {
  const REFUND_REQUEST_ID = "refund-request-1";

  beforeEach(() => {
    mockRedirect.mockClear();
    mockExecuteApprovedRefund.mockReset();
    mockCookieStore.get.mockImplementation(() => undefined);
    mockCreateClient.mockResolvedValue({});
  });

  it("redirects with a ledger_v1-specific message, distinct from the generic Stripe error wording", async () => {
    mockExecuteApprovedRefund.mockResolvedValue({ kind: "ledger_v1_not_supported" });

    await expect(issueStripeRefund(REFUND_REQUEST_ID)).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedUrl = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedUrl).toContain(`/admin/refunds/${REFUND_REQUEST_ID}?error=`);
    expect(decodeURIComponent(redirectedUrl)).toContain("ledger_v1");
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });
});
