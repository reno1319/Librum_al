import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  RECOVERY_COOKIE_NAME,
  isRecoverySessionActive,
  shouldRedirectForRecovery,
} from "@/lib/recovery-session";

// LAUNCH-1 P1-11: these Server Actions are genuinely worth testing
// directly here (unlike requireAdmin(), which src/lib/auth.test.ts's own
// comment explains is deliberately NOT re-tested through a heavy mock,
// since that would just re-verify pre-existing Supabase auth/RLS
// semantics this codebase already trusts). What's under test in this
// file is brand-new branching THIS change introduces -- whether the
// recovery cookie gets cleared and the session gets signed out, on
// exactly which of several outcomes -- not Supabase's own behavior. All
// four dependencies below are mocked at the same "network/framework
// boundary" level already established by src/app/api/internal/
// reconcile-transfer-reversals/route.test.ts (which mocks
// @/lib/supabase/admin and @/lib/stripe the same way), not by faking
// Next.js's own request/cookie semantics.
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

const mockCookieStore = { get: vi.fn(), set: vi.fn(), delete: vi.fn() };
const mockCookies = vi.fn(() => Promise.resolve(mockCookieStore));
vi.mock("next/headers", () => ({ cookies: () => mockCookies() }));

let mockSupabaseAuth: {
  getUser: ReturnType<typeof vi.fn>;
  updateUser: ReturnType<typeof vi.fn>;
  signOut: ReturnType<typeof vi.fn>;
  signInWithPassword: ReturnType<typeof vi.fn>;
  signUp: ReturnType<typeof vi.fn>;
};
const mockCreateClient = vi.fn(() => Promise.resolve({ auth: mockSupabaseAuth }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

const { updatePassword, logout, login, signup } = await import("./actions");

function resetMocks() {
  mockRedirect.mockClear();
  mockCookies.mockClear();
  mockCookieStore.get.mockClear();
  mockCookieStore.set.mockClear();
  mockCookieStore.delete.mockClear();
  mockCreateClient.mockClear();
  mockSupabaseAuth = {
    getUser: vi.fn(() => Promise.resolve({ data: { user: { id: "user-1" } } })),
    updateUser: vi.fn(() => Promise.resolve({ error: null })),
    signOut: vi.fn(() => Promise.resolve({ error: null })),
    signInWithPassword: vi.fn(() => Promise.resolve({ error: null })),
    signUp: vi.fn(() =>
      Promise.resolve({ data: { session: { access_token: "tok" } }, error: null }),
    ),
  };
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}

async function expectRedirectTo(promise: Promise<unknown>, target: string) {
  await expect(promise).rejects.toBeInstanceOf(RedirectSignal);
  expect(mockRedirect).toHaveBeenCalledWith(expect.stringContaining(target));
}

describe("updatePassword: recovery-state lifecycle", () => {
  beforeEach(resetMocks);

  it("successful update clears recovery state", async () => {
    await expectRedirectTo(
      updatePassword(formData({ password: "newpass1", confirmPassword: "newpass1" })),
      "/login",
    );
    expect(mockCookieStore.delete).toHaveBeenCalledExactlyOnceWith(RECOVERY_COOKIE_NAME);
  });

  it("successful update signs out", async () => {
    await expectRedirectTo(
      updatePassword(formData({ password: "newpass1", confirmPassword: "newpass1" })),
      "/login",
    );
    expect(mockSupabaseAuth.signOut).toHaveBeenCalledOnce();
  });

  it("failed password-length validation does NOT clear recovery state or sign out", async () => {
    await expectRedirectTo(
      updatePassword(formData({ password: "short", confirmPassword: "short" })),
      "/reset-password",
    );
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
    expect(mockSupabaseAuth.signOut).not.toHaveBeenCalled();
    expect(mockSupabaseAuth.updateUser).not.toHaveBeenCalled();
  });

  it("mismatched confirmation does NOT clear recovery state or sign out", async () => {
    await expectRedirectTo(
      updatePassword(formData({ password: "newpass1", confirmPassword: "different1" })),
      "/reset-password",
    );
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
    expect(mockSupabaseAuth.signOut).not.toHaveBeenCalled();
  });

  it("a failed supabase.auth.updateUser() does NOT clear recovery state or sign out", async () => {
    mockSupabaseAuth.updateUser.mockResolvedValue({ error: { message: "weak password" } });
    await expectRedirectTo(
      updatePassword(formData({ password: "newpass1", confirmPassword: "newpass1" })),
      "/reset-password",
    );
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
    expect(mockSupabaseAuth.signOut).not.toHaveBeenCalled();
  });

  it("no authenticated user (expired link) redirects to /login without touching recovery state", async () => {
    mockSupabaseAuth.getUser.mockResolvedValue({ data: { user: null } });
    await expectRedirectTo(
      updatePassword(formData({ password: "newpass1", confirmPassword: "newpass1" })),
      "/login",
    );
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
    expect(mockSupabaseAuth.signOut).not.toHaveBeenCalled();
  });
});

describe("logout: clears recovery state", () => {
  beforeEach(resetMocks);

  it("clears the recovery cookie in addition to signing out", async () => {
    await expectRedirectTo(logout(), "/");
    expect(mockSupabaseAuth.signOut).toHaveBeenCalledOnce();
    expect(mockCookieStore.delete).toHaveBeenCalledExactlyOnceWith(RECOVERY_COOKIE_NAME);
  });
});

describe("login: never marked as a recovery session", () => {
  beforeEach(resetMocks);

  // LAUNCH-1 P1-11 STALE-MARKER CORRECTION: a successful ordinary login
  // now DOES touch the cookie store -- to clear any stale recovery
  // marker left over from an earlier abandoned recovery attempt in the
  // same browser (see the "clears a stale recovery marker" test below).
  // What must remain true is narrower and still verified here: login()
  // never ORIGINATES a recovery marker -- it only ever calls
  // clearRecoverySession() (delete), never setRecoverySession() (set).
  it("ordinary password login never sets/creates a recovery marker, only ever clears one", async () => {
    // next="/" takes login()'s early same-site-redirect branch, which
    // needs no `profiles` lookup -- keeps this test's fake Supabase
    // client scoped to exactly `.auth`, matching every other test in
    // this file, rather than also mocking `.from(...)` for a role
    // lookup unrelated to what's actually under test here.
    await expectRedirectTo(
      login(formData({ email: "reader@example.com", password: "hunter2", next: "/" })),
      "/",
    );
    expect(mockCookieStore.set).not.toHaveBeenCalled();
  });

  it("a successful ordinary login clears a stale recovery marker (abandoned-recovery + later ordinary login regression)", async () => {
    await expectRedirectTo(
      login(formData({ email: "reader@example.com", password: "hunter2", next: "/" })),
      "/",
    );
    expect(mockCookieStore.delete).toHaveBeenCalledExactlyOnceWith(RECOVERY_COOKIE_NAME);
  });

  it("invalid credentials do NOT clear an existing recovery marker", async () => {
    mockSupabaseAuth.signInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    await expectRedirectTo(
      login(formData({ email: "reader@example.com", password: "wrong", next: "/" })),
      "/login",
    );
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
  });

  // LAUNCH-1 P1: login()'s `next` handling is routed through
  // resolveSafeInternalPath (src/lib/safe-redirect.ts) rather than a local
  // `next.startsWith("/")` check -- these regression tests prove the
  // Server Action itself, end to end, not just the pure helper (already
  // covered directly in src/lib/safe-redirect.test.ts).
  describe("post-login `next` redirect safety", () => {
    it("a legitimate same-site next redirects there", async () => {
      await expectRedirectTo(
        login(formData({ email: "reader@example.com", password: "hunter2", next: "/library" })),
        "/library",
      );
    });

    it("a protocol-relative next does NOT redirect off-site -- falls back to the normal role-based destination", async () => {
      // mockImplementationOnce (not mockResolvedValue/mockImplementation)
      // deliberately -- it reverts to the module-level default after this
      // one call, so it can't leak a stale mockSupabaseAuth reference (or
      // this test's `from()` shape) into any other test in this file.
      mockCreateClient.mockImplementationOnce(() =>
        Promise.resolve({
          auth: mockSupabaseAuth,
          from: () => ({
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { role: "reader" } }),
              }),
            }),
          }),
        } as never),
      );

      await expectRedirectTo(
        login(
          formData({
            email: "reader@example.com",
            password: "hunter2",
            next: "//evil.com/phish",
          }),
        ),
        "/",
      );

      expect(mockRedirect).not.toHaveBeenCalledWith(expect.stringContaining("evil.com"));
    });

    it("a backslash-host next does NOT redirect off-site -- falls back to the normal role-based destination", async () => {
      mockCreateClient.mockImplementationOnce(() =>
        Promise.resolve({
          auth: mockSupabaseAuth,
          from: () => ({
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { role: "reader" } }),
              }),
            }),
          }),
        } as never),
      );

      await expectRedirectTo(
        login(
          formData({
            email: "reader@example.com",
            password: "hunter2",
            next: "/\\evil.com/phish",
          }),
        ),
        "/",
      );

      expect(mockRedirect).not.toHaveBeenCalledWith(expect.stringContaining("evil.com"));
    });

    it("an invalid next falls back to the author role-based destination, not an error page", async () => {
      mockCreateClient.mockImplementationOnce(() =>
        Promise.resolve({
          auth: mockSupabaseAuth,
          from: () => ({
            select: () => ({
              eq: () => ({
                single: () => Promise.resolve({ data: { role: "author" } }),
              }),
            }),
          }),
        } as never),
      );

      await expectRedirectTo(
        login(
          formData({
            email: "author@example.com",
            password: "hunter2",
            next: "https://evil.com/phish",
          }),
        ),
        "/dashboard",
      );
    });
  });

  // LAUNCH-1 P1-11 STALE-MARKER CORRECTION: the explicit end-to-end
  // regression named in the correction's own spec -- recovery marker
  // exists (an earlier recovery attempt was abandoned) -> a LATER,
  // unrelated ordinary login succeeds -> the marker is genuinely absent
  // afterward, not merely "not asserted on" -> which is exactly what
  // makes Proxy's own shouldRedirectForRecovery() resolve to "do not
  // redirect" for /library. Unlike the spy-based tests above, this one
  // uses a small STATEFUL fake cookie store (a real Map, not just call
  // counters) so it can prove the store's actual resulting content, and
  // chains directly into the real, already-exhaustively-tested
  // isRecoverySessionActive()/shouldRedirectForRecovery() predicates
  // (src/lib/recovery-session.ts) rather than re-deriving the proxy
  // decision by hand.
  it("full lifecycle: abandoned recovery marker + later successful ordinary login -> marker absent -> /library would not be recovery-redirected", async () => {
    const store = new Map<string, string>([[RECOVERY_COOKIE_NAME, "1"]]);
    const statefulCookieStore = {
      get: (name: string) => (store.has(name) ? { value: store.get(name)! } : undefined),
      set: (name: string, value: string) => {
        store.set(name, value);
      },
      delete: (name: string) => {
        store.delete(name);
      },
    };
    mockCookies.mockResolvedValueOnce(statefulCookieStore as never);

    // Precondition: the stale marker really is present beforehand.
    expect(isRecoverySessionActive(statefulCookieStore)).toBe(true);

    await expectRedirectTo(
      login(formData({ email: "reader@example.com", password: "hunter2", next: "/" })),
      "/",
    );

    // login() actually cleared it on the real store, not merely a spy.
    expect(isRecoverySessionActive(statefulCookieStore)).toBe(false);
    // ...which is exactly what makes Proxy's own decision resolve to
    // "no redirect" for /library afterward.
    expect(
      shouldRedirectForRecovery("/library", isRecoverySessionActive(statefulCookieStore)),
    ).toBe(false);
  });
});

// LAUNCH-1 P1-11 SIGNUP STALE-RECOVERY-MARKER FINAL CORRECTION: signup()
// is a THIRD ordinary-session-establishing path (alongside login() and
// the callback route's non-recovery branch) -- missed by the original
// stale-marker correction, caught by the final pre-commit audit.
// signUp() only sometimes establishes a session immediately (only when
// the project doesn't require email confirmation); these tests cover
// both branches explicitly.
describe("signup: stale recovery marker", () => {
  beforeEach(resetMocks);

  function signupFormData(overrides: Record<string, string> = {}) {
    return formData({
      email: "newauthor@example.com",
      password: "hunter2",
      displayName: "New Author",
      role: "reader",
      // LAUNCH-1 P2: every test below exercises signup()'s ordinary
      // behavior downstream of the consent gate -- accept_terms defaults
      // to accepted here so those tests keep proving what they already
      // proved before the gate existed. The gate itself is covered
      // separately, in its own describe block below.
      accept_terms: "on",
      ...overrides,
    });
  }

  it("1. successful signup with data.session truthy clears a stale recovery marker", async () => {
    await expectRedirectTo(signup(signupFormData()), "/");
    expect(mockCookieStore.delete).toHaveBeenCalledExactlyOnceWith(RECOVERY_COOKIE_NAME);
  });

  it("2. successful signup with data.session truthy and no stale marker behaves normally", async () => {
    // clearRecoverySession() is called unconditionally on this path (it
    // is always safe/idempotent whether or not a marker was actually
    // present) -- what matters here is that the ordinary redirect
    // behavior is completely unaffected either way.
    await expectRedirectTo(signup(signupFormData({ role: "author" })), "/dashboard");
    expect(mockCookieStore.delete).toHaveBeenCalledExactlyOnceWith(RECOVERY_COOKIE_NAME);
  });

  it("3. signUp error does NOT clear the recovery marker", async () => {
    mockSupabaseAuth.signUp.mockResolvedValue({
      data: { session: null },
      error: { message: "User already registered" },
    });
    await expectRedirectTo(signup(signupFormData()), "/signup");
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
    expect(mockCookieStore.set).not.toHaveBeenCalled();
  });

  it("4. successful signup with data.session null (email confirmation required) does NOT clear the recovery marker", async () => {
    mockSupabaseAuth.signUp.mockResolvedValue({ data: { session: null }, error: null });
    await expectRedirectTo(signup(signupFormData()), "/signup/check-email");
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
    expect(mockCookieStore.set).not.toHaveBeenCalled();
  });

  it("5. the data.session === null path still redirects to /signup/check-email exactly as before -- unchanged business behavior", async () => {
    mockSupabaseAuth.signUp.mockResolvedValue({ data: { session: null }, error: null });
    await expectRedirectTo(signup(signupFormData()), "/signup/check-email");
  });

  it("signup() never originates a recovery marker and never signs the new session out", async () => {
    await expectRedirectTo(signup(signupFormData()), "/");
    expect(mockCookieStore.set).not.toHaveBeenCalled();
    expect(mockSupabaseAuth.signOut).not.toHaveBeenCalled();
  });

  // LAUNCH-1 P1-11 SIGNUP FINAL CORRECTION: the explicit lifecycle
  // regression named in the correction's own spec.
  it("full lifecycle: stale recovery marker exists -> signup succeeds with an immediate session -> marker cleared -> resulting session is not recovery-restricted", async () => {
    const store = new Map<string, string>([[RECOVERY_COOKIE_NAME, "1"]]);
    const statefulCookieStore = {
      get: (name: string) => (store.has(name) ? { value: store.get(name)! } : undefined),
      set: (name: string, value: string) => {
        store.set(name, value);
      },
      delete: (name: string) => {
        store.delete(name);
      },
    };
    mockCookies.mockResolvedValueOnce(statefulCookieStore as never);

    expect(isRecoverySessionActive(statefulCookieStore)).toBe(true);

    await expectRedirectTo(signup(signupFormData()), "/");

    expect(isRecoverySessionActive(statefulCookieStore)).toBe(false);
    expect(
      shouldRedirectForRecovery("/library", isRecoverySessionActive(statefulCookieStore)),
    ).toBe(false);
  });
});

// LAUNCH-1 P2: signup()'s Terms/Privacy clickwrap gate. Routed through a
// direct FormData check (`formData.get("accept_terms") === "on"`), not
// the checkbox's own `required` HTML attribute -- a direct POST to this
// Server Action bypasses browser-level form validation entirely, so the
// gate must be provably enforced here, before supabase.auth.signUp() is
// ever reachable.
describe("signup: Terms/Privacy consent gate", () => {
  beforeEach(resetMocks);

  function signupFormData(overrides: Record<string, string> = {}) {
    return formData({
      email: "newauthor@example.com",
      password: "hunter2",
      displayName: "New Author",
      role: "reader",
      accept_terms: "on",
      ...overrides,
    });
  }

  it("1. missing accept_terms redirects with the consent error, and signUp is never called", async () => {
    const fd = signupFormData();
    fd.delete("accept_terms");
    await expectRedirectTo(
      signup(fd),
      "/signup?error=You%20must%20agree%20to%20the%20Terms%20of%20Service%20before%20creating%20an%20account.",
    );
    expect(mockSupabaseAuth.signUp).not.toHaveBeenCalled();
  });

  it("2. a false-equivalent accept_terms value ('off') does not satisfy the gate -- signUp is never called", async () => {
    await expectRedirectTo(signup(signupFormData({ accept_terms: "off" })), "/signup?error=");
    expect(mockSupabaseAuth.signUp).not.toHaveBeenCalled();
  });

  it("3. accept_terms='on' satisfies the gate -- signUp is called normally", async () => {
    await expectRedirectTo(signup(signupFormData()), "/");
    expect(mockSupabaseAuth.signUp).toHaveBeenCalledOnce();
  });

  it("4. reader signup with acceptance: existing reader flow (redirect to '/') is unchanged", async () => {
    await expectRedirectTo(signup(signupFormData({ role: "reader" })), "/");
  });

  it("5. author signup with acceptance: existing author flow (redirect to '/dashboard') is unchanged", async () => {
    await expectRedirectTo(signup(signupFormData({ role: "author" })), "/dashboard");
  });

  it("6. email-confirmation-required signup with acceptance still redirects to /signup/check-email", async () => {
    mockSupabaseAuth.signUp.mockResolvedValue({ data: { session: null }, error: null });
    await expectRedirectTo(signup(signupFormData()), "/signup/check-email");
  });

  it("7. immediate-session signup with acceptance: existing success redirect is unchanged", async () => {
    await expectRedirectTo(signup(signupFormData()), "/");
    expect(mockSupabaseAuth.signUp).toHaveBeenCalledOnce();
  });

  it("8. successful immediate signup with acceptance still clears a stale P1-11 recovery marker", async () => {
    await expectRedirectTo(signup(signupFormData()), "/");
    expect(mockCookieStore.delete).toHaveBeenCalledExactlyOnceWith(RECOVERY_COOKIE_NAME);
  });

  it("9. a Supabase signUp error after acceptance still surfaces the existing Supabase error, not the consent error", async () => {
    mockSupabaseAuth.signUp.mockResolvedValue({
      data: { session: null },
      error: { message: "User already registered" },
    });
    await expectRedirectTo(
      signup(signupFormData()),
      "/signup?error=User%20already%20registered",
    );
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
  });
});
