import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// LAUNCH-1 P1-11: minimal, focused coverage of ONLY the new recovery
// guard added to issueStripeRefund -- see buyBook's equivalent test
// (src/app/books/[id]/actions.test.ts) for the full rationale.
// requireAdmin() is mocked to always succeed so this test isolates the
// recovery guard specifically -- proving the invariant applies even to
// an admin's own account, not conflating it with admin-authorization
// testing (already covered separately by src/lib/auth.test.ts).
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

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(() =>
    Promise.resolve({ user: { id: "admin-1" }, profile: { role: "admin" } }),
  ),
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
