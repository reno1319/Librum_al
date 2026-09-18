import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ALL-CUTOVER APP-A: focused coverage of the maintenance gate added to
// every exported action in this file -- not a general re-test of
// bundle business logic (which has its own coverage elsewhere).
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

// publishBundle/unpublishBundle/deleteBundle all call this immediately
// after their own maintenance gate -- mocked so the gate tests below
// can assert it's never reached.
const mockRedirectIfRecoverySessionActive = vi.fn();
vi.mock("@/lib/recovery-guard", () => ({
  redirectIfRecoverySessionActive: mockRedirectIfRecoverySessionActive,
}));

const { createBundle, updateBundle, publishBundle, unpublishBundle, deleteBundle } =
  await import("./actions");

const BUNDLE_ID = "bundle-1";

describe("bundle actions: maintenance-mode gate", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    mockRedirectIfRecoverySessionActive.mockClear();
    vi.stubEnv("ALL_CUTOVER_MAINTENANCE_MODE", "active");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("createBundle redirects with the maintenance message and never reaches Supabase", async () => {
    await expect(createBundle(new FormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/dashboard/bundles?error="));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("updateBundle redirects with the maintenance message and never reaches Supabase", async () => {
    await expect(updateBundle(BUNDLE_ID, new FormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith(
      expect.stringContaining(`/dashboard/bundles/${BUNDLE_ID}/edit?error=`),
    );
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("publishBundle redirects with the maintenance message before the recovery-session check or any Supabase call", async () => {
    await expect(publishBundle(BUNDLE_ID)).rejects.toBeInstanceOf(RedirectSignal);
    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/dashboard/bundles?error="));
    expect(mockRedirectIfRecoverySessionActive).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("unpublishBundle throws the stable maintenance error before the recovery-session check or any Supabase call", async () => {
    await expect(unpublishBundle(BUNDLE_ID)).rejects.toThrow(
      "Librum is temporarily unavailable for scheduled maintenance",
    );
    expect(mockRedirectIfRecoverySessionActive).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("deleteBundle throws the stable maintenance error before the recovery-session check or any Supabase call", async () => {
    await expect(deleteBundle(BUNDLE_ID)).rejects.toThrow(
      "Librum is temporarily unavailable for scheduled maintenance",
    );
    expect(mockRedirectIfRecoverySessionActive).not.toHaveBeenCalled();
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("maintenance mode off (unset) preserves createBundle's existing allowed behavior", async () => {
    vi.unstubAllEnvs();
    mockCreateClient.mockResolvedValue({
      auth: { getUser: async () => ({ data: { user: { id: "author-1" } } }) },
    });

    // No form fields set -- expected to fail its own existing
    // validation, not the maintenance gate; proves the gate itself is
    // off and the function proceeds into its normal logic.
    await expect(createBundle(new FormData())).rejects.toMatchObject({
      target: "/dashboard/bundles?error=Please+fill+in+every+field",
    });
    expect(mockCreateClient).toHaveBeenCalled();
  });
});
