import { describe, expect, it, vi, beforeEach } from "vitest";

// ADMIN-1A.5: staffLogin() authenticates via the exact same Supabase Auth
// call ordinary login() uses -- this suite covers only what's specific to
// this action: the fixed generic error message (never a raw Supabase
// error), the safe-next round trip back to /admin/login, and that the
// recovery marker is cleared only on a confirmed successful sign-in
// (mirroring src/app/auth/actions.ts's own login() precedent). It does
// NOT test staff authorization -- that decision belongs entirely to
// src/app/admin/login/page.tsx (see page.test.ts), not this action.
class RedirectSignal extends Error {
  constructor(public target: string) {
    super(`REDIRECT:${target}`);
  }
}

const mockRedirect = vi.fn((url: string) => {
  throw new RedirectSignal(url);
});
vi.mock("next/navigation", () => ({ redirect: mockRedirect }));

const mockCookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
vi.mock("next/headers", () => ({ cookies: () => Promise.resolve(mockCookieStore) }));

const mockSignInWithPassword = vi.fn();
const mockCreateClient = vi.fn(() =>
  Promise.resolve({ auth: { signInWithPassword: mockSignInWithPassword } }),
);
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const mockClearRecoverySession = vi.fn();
vi.mock("@/lib/recovery-session", () => ({
  clearRecoverySession: (store: unknown) => mockClearRecoverySession(store),
}));

const { staffLogin } = await import("./actions");

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

describe("staffLogin", () => {
  beforeEach(() => {
    mockRedirect.mockClear();
    mockSignInWithPassword.mockReset();
    mockClearRecoverySession.mockClear();
    mockCookieStore.delete.mockClear();
  });

  it("invalid credentials: redirects with the fixed generic message, never the raw Supabase error", async () => {
    mockSignInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });

    await expect(
      staffLogin(formData({ email: "a@b.com", password: "wrong" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(
      encodeURIComponent("Unable to sign in. Check your credentials and try again."),
    );
    expect(redirectedTo).not.toContain("Invalid login credentials");
    expect(mockClearRecoverySession).not.toHaveBeenCalled();
  });

  it("invalid credentials with a pending next: the safe next is preserved in the error redirect", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: { message: "some error" } });

    await expect(
      staffLogin(formData({ email: "a@b.com", password: "wrong", next: "/admin/reports" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).toContain(`next=${encodeURIComponent("/admin/reports")}`);
  });

  it("invalid credentials with an unsafe next: the unsafe value is dropped, not echoed back", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: { message: "some error" } });

    await expect(
      staffLogin(formData({ email: "a@b.com", password: "wrong", next: "https://evil.com" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    const redirectedTo = mockRedirect.mock.calls[0][0] as string;
    expect(redirectedTo).not.toContain("evil.com");
    expect(redirectedTo).not.toContain("next=");
  });

  it("valid credentials, no next: redirects to /admin/login and clears any stale recovery marker", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });

    await expect(
      staffLogin(formData({ email: "staff@librum.al", password: "correct" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/admin/login");
    expect(mockClearRecoverySession).toHaveBeenCalledWith(mockCookieStore);
  });

  it("valid credentials with a safe next: redirects to /admin/login?next=<safe path>", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });

    await expect(
      staffLogin(
        formData({ email: "staff@librum.al", password: "correct", next: "/admin/refunds" }),
      ),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith(
      `/admin/login?next=${encodeURIComponent("/admin/refunds")}`,
    );
  });

  it("valid credentials with an unsafe next (e.g. /dashboard): redirects to plain /admin/login, next dropped", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });

    await expect(
      staffLogin(formData({ email: "staff@librum.al", password: "correct", next: "/dashboard" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockRedirect).toHaveBeenCalledWith("/admin/login");
  });

  it("calls signInWithPassword with exactly the submitted email/password -- no second auth backend, no role/owner field read", async () => {
    mockSignInWithPassword.mockResolvedValue({ error: null });

    await expect(
      staffLogin(formData({ email: "owner@librum.al", password: "hunter2" })),
    ).rejects.toBeInstanceOf(RedirectSignal);

    expect(mockSignInWithPassword).toHaveBeenCalledWith({
      email: "owner@librum.al",
      password: "hunter2",
    });
  });
});
