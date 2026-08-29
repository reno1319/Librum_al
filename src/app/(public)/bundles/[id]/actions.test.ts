import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// LAUNCH-1 P1-11: minimal, focused coverage of ONLY the new recovery
// guard added to buyBundle -- see the equivalent buyBook test
// (src/app/books/[id]/actions.test.ts) for the full rationale.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const mockCookieStore = {
  get: vi.fn((name: string) => (name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined)),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));
const mockCreateAdminClient = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mockCreateAdminClient() }));
const mockCheckoutSessionsCreate = vi.fn();
vi.mock("@/lib/stripe", () => ({
  stripe: { checkout: { sessions: { create: mockCheckoutSessionsCreate } } },
}));

const { buyBundle } = await import("./actions");

describe("buyBundle: recovery-session defense-in-depth", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    mockCreateAdminClient.mockClear();
    mockCheckoutSessionsCreate.mockClear();
  });

  it("redirects to /reset-password and never reaches Supabase or Stripe when a recovery session is active", async () => {
    await expect(buyBundle("bundle-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(mockCreateAdminClient).not.toHaveBeenCalled();
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
});
