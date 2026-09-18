import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ALL-CUTOVER APP-A: focused coverage of the maintenance gate added to
// every exported action in this file -- not a general re-test of
// discount-code business logic (which has its own coverage elsewhere).
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

const { createDiscountCode, toggleDiscountCode, deleteDiscountCode } = await import("./actions");

describe("discount code actions: maintenance-mode gate", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("createDiscountCode redirects with the maintenance message and never reaches Supabase", async () => {
    await expect(createDiscountCode(new FormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/dashboard/discounts?error="));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("toggleDiscountCode throws the stable maintenance error and never reaches Supabase", async () => {
    await expect(toggleDiscountCode("code-1", true)).rejects.toThrow(
      "Librum is temporarily unavailable for scheduled maintenance",
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("deleteDiscountCode throws the stable maintenance error and never reaches Supabase", async () => {
    await expect(deleteDiscountCode("code-1")).rejects.toThrow(
      "Librum is temporarily unavailable for scheduled maintenance",
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves createDiscountCode's existing allowed behavior", async () => {
    vi.unstubAllEnvs();
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "author-1" } } }) },
    });

    // No form fields set -- expected to fail its own existing
    // validation, not the maintenance gate; proves the gate itself is
    // off and the function proceeds into its normal logic.
    await expect(createDiscountCode(new FormData())).rejects.toMatchObject({
      target: "/dashboard/discounts?error=Please+fill+in+every+field",
    });
    expect(mockCreateClient).toHaveBeenCalled();
  });
});
