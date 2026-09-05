import { describe, expect, it, vi, beforeEach } from "vitest";
import { RECOVERY_COOKIE_NAME } from "@/lib/recovery-session";

// AUTH-1C: minimal, focused coverage of ONLY the recovery guards added
// to publishBundle()/unpublishBundle()/deleteBundle() -- mirrors the
// existing "recovery-session defense-in-depth" pattern already
// established for buyBundle (src/app/bundles/[id]/actions.test.ts).
// dashboard/bundles/actions.ts had no test file at all before this
// pass; this file is deliberately scoped to only the new guards, not a
// general audit of createBundle()/updateBundle() (unguarded, see the
// AUTH-1C classification report).
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

const mockCookieStore = {
  get: vi.fn((name: string) => (name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined)),
};
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockCreateClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { publishBundle, unpublishBundle, deleteBundle } = await import("./actions");

describe("publishBundle/unpublishBundle/deleteBundle: recovery-session defense-in-depth (AUTH-1C)", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockCreateClient.mockClear();
    mockCookieStore.get.mockImplementation((name: string) =>
      name === RECOVERY_COOKIE_NAME ? { value: "1" } : undefined,
    );
  });

  it("publishBundle: redirects to /reset-password and never touches Supabase when a recovery session is active", async () => {
    await expect(publishBundle("bundle-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("unpublishBundle: redirects to /reset-password and never touches Supabase when a recovery session is active", async () => {
    await expect(unpublishBundle("bundle-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("deleteBundle: redirects to /reset-password and never touches Supabase when a recovery session is active", async () => {
    await expect(deleteBundle("bundle-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining("/reset-password"));
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it("no active recovery session: publishBundle proceeds past the guard (reaches Supabase)", async () => {
    mockCookieStore.get.mockImplementation(() => undefined);
    mockCreateClient.mockResolvedValue({
      auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
    });

    // With no user, publishBundle() redirects to "/login" -- proving the
    // guard itself did NOT fire (it would have redirected to
    // "/reset-password" instead), and that createClient() was reached.
    await expect(publishBundle("bundle-1")).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/login");
    expect(mockCreateClient).toHaveBeenCalledOnce();
  });
});
