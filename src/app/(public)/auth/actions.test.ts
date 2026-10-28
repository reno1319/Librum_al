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
  resetPasswordForEmail: ReturnType<typeof vi.fn>;
};
const mockCreateClient = vi.fn(() => Promise.resolve({ auth: mockSupabaseAuth }));
vi.mock("@/lib/supabase/server", () => ({ createClient: () => mockCreateClient() }));

// AUTHOR-AGE-1 / SECURITY-9A: the sign-up records (Terms, 18+) are
// written through the service role's auth admin API
// (src/lib/agreement-records.ts), and an author sign-up is switched from
// reader to author with the author-role writer, which is the same
// service-role client (src/lib/author-role-write-client.ts).
const mockUpdateUserById = vi.fn((_id: string, _attributes: unknown) => {
  order.push("record");
  return Promise.resolve({ data: null, error: null as unknown });
});
type RoleWrite = { table: string; values: unknown; filters: Array<[string, unknown]>; columns: string };
let roleWrites: RoleWrite[] = [];
let order: string[] = [];
// null: answer with exactly the filtered row, now an author.
let roleWriteResult: { data: unknown; error: unknown } | null = null;
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    auth: { admin: { updateUserById: (id: string, attributes: unknown) => mockUpdateUserById(id, attributes) } },
    from: (table: string) => ({
      update: (values: unknown) => {
        const write: RoleWrite = { table, values, filters: [], columns: "" };
        roleWrites.push(write);
        order.push("switch");
        const chain = {
          eq: (column: string, value: unknown) => {
            write.filters.push([column, value]);
            return chain;
          },
          select: async (columns: string) => {
            write.columns = columns;
            if (roleWriteResult) return roleWriteResult;
            const id = write.filters.find(([column]) => column === "id")?.[1];
            return { data: [{ id, role: "author" }], error: null };
          },
        };
        return chain;
      },
    }),
  }),
}));

// A signUp() answer for an account really created (it has an identity).
const CREATED_ID = "55555555-5555-4555-8555-555555555555";
function createdUser(session: unknown) {
  return { data: { session, user: { id: CREATED_ID, identities: [{ id: "identity-1" }] } }, error: null };
}

const { updatePassword, logout, login, signup, requestPasswordReset } = await import("./actions");

function resetMocks() {
  mockRedirect.mockClear();
  mockUpdateUserById.mockClear();
  roleWrites = [];
  order = [];
  roleWriteResult = null;
  mockCookies.mockClear();
  mockCookieStore.get.mockClear();
  mockCookieStore.set.mockClear();
  mockCookieStore.delete.mockClear();
  mockCreateClient.mockClear();
  mockSupabaseAuth = {
    getUser: vi.fn(() => Promise.resolve({ data: { user: { id: "user-1" } } })),
    updateUser: vi.fn(() => Promise.resolve({ error: null })),
    signOut: vi.fn(() => Promise.resolve({ error: null })),
    signInWithPassword: vi.fn(() =>
      Promise.resolve({ data: { user: { id: "signed-in-user" } }, error: null }),
    ),
    signUp: vi.fn(() => Promise.resolve(createdUser({ access_token: "tok" }))),
    resetPasswordForEmail: vi.fn(() => Promise.resolve({ data: {}, error: null })),
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

describe("requestPasswordReset: provider failures and anti-enumeration", () => {
  beforeEach(resetMocks);

  it("rejects an empty email before calling Supabase", async () => {
    await expectRedirectTo(requestPasswordReset(formData({ email: "" })), "Shkruani%20emailin.");
    expect(mockSupabaseAuth.resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("keeps the generic success response when Supabase returns no error", async () => {
    await expectRedirectTo(
      requestPasswordReset(formData({ email: "  reader@example.com  " })),
      "/forgot-password?success=1",
    );

    expect(mockSupabaseAuth.resetPasswordForEmail).toHaveBeenCalledWith(
      "reader@example.com",
      {
        redirectTo: expect.stringContaining("/auth/callback?next=/reset-password"),
      },
    );
  });

  it("shows a safe temporary error when Supabase returns a provider error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockSupabaseAuth.resetPasswordForEmail.mockResolvedValue({
      data: {},
      error: {
        code: "over_email_send_rate_limit",
        status: 429,
        message: "provider detail that must not be exposed",
      },
    });

    try {
      await expectRedirectTo(
        requestPasswordReset(formData({ email: "private@example.com" })),
        encodeURIComponent("Nuk mundëm ta dërgojmë emailin e rivendosjes tani."),
      );

      expect(consoleError).toHaveBeenCalledWith(
        "requestPasswordReset: password-reset provider request failed",
        { code: "over_email_send_rate_limit", status: 429 },
      );
      const logged = JSON.stringify(consoleError.mock.calls);
      expect(logged).not.toContain("private@example.com");
      expect(logged).not.toContain("provider detail that must not be exposed");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("shows the same safe temporary error when the provider request throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockSupabaseAuth.resetPasswordForEmail.mockRejectedValue(
      new Error("transport detail that must not be exposed"),
    );

    try {
      await expectRedirectTo(
        requestPasswordReset(formData({ email: "private@example.com" })),
        encodeURIComponent("Nuk mundëm ta dërgojmë emailin e rivendosjes tani."),
      );

      expect(consoleError).toHaveBeenCalledExactlyOnceWith(
        "requestPasswordReset: password-reset provider request threw",
      );
      const logged = JSON.stringify(consoleError.mock.calls);
      expect(logged).not.toContain("private@example.com");
      expect(logged).not.toContain("transport detail that must not be exposed");
    } finally {
      consoleError.mockRestore();
    }
  });
});

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

  it("uses the user returned by signInWithPassword for a reader role lookup without re-reading the new session", async () => {
    const eq = vi.fn(() => ({
      single: () => Promise.resolve({ data: { role: "reader" } }),
    }));
    mockCreateClient.mockImplementationOnce(() =>
      Promise.resolve({
        auth: mockSupabaseAuth,
        from: () => ({
          select: () => ({ eq }),
        }),
      } as never),
    );

    await expectRedirectTo(
      login(formData({ email: "reader@example.com", password: "hunter2" })),
      "/",
    );

    expect(eq).toHaveBeenCalledExactlyOnceWith("id", "signed-in-user");
    expect(mockSupabaseAuth.getUser).not.toHaveBeenCalled();
  });

  it("uses the user returned by signInWithPassword and preserves the author dashboard redirect", async () => {
    const eq = vi.fn(() => ({
      single: () => Promise.resolve({ data: { role: "author" } }),
    }));
    mockCreateClient.mockImplementationOnce(() =>
      Promise.resolve({
        auth: mockSupabaseAuth,
        from: () => ({
          select: () => ({ eq }),
        }),
      } as never),
    );

    await expectRedirectTo(
      login(formData({ email: "author@example.com", password: "hunter2" })),
      "/dashboard",
    );

    expect(eq).toHaveBeenCalledExactlyOnceWith("id", "signed-in-user");
    expect(mockSupabaseAuth.getUser).not.toHaveBeenCalled();
  });

  it("fails safely when a nominally successful sign-in returns no user", async () => {
    mockSupabaseAuth.signInWithPassword.mockResolvedValue({
      data: { user: null },
      error: null,
    });

    await expectRedirectTo(
      login(formData({ email: "reader@example.com", password: "hunter2" })),
      "/login?error=Hyrja%20nuk%20u%20krye.%20Provoni%20p%C3%ABrs%C3%ABri.",
    );

    expect(mockSupabaseAuth.getUser).not.toHaveBeenCalled();
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
  });

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

  // PEOPLE-2: Supabase checks a ban before the password, so a banned
  // account must look exactly like a wrong password, URL included.
  it("a banned account gets the wrong-password redirect, never the ban message", async () => {
    mockSupabaseAuth.signInWithPassword.mockResolvedValue({
      error: { code: "user_banned", message: "User is banned" },
    });
    const resume = "/library";
    await expectRedirectTo(
      login(formData({ email: "reader@example.com", password: "anything", next: resume })),
      `/login?error=Invalid%20login%20credentials&next=${encodeURIComponent(resume)}`,
    );
    expect(String(mockRedirect.mock.calls.at(-1)?.[0])).not.toMatch(/banned|suspended/i);
    expect(mockCookieStore.delete).not.toHaveBeenCalled();
  });

  // QA-FIX-1: a mistyped password must not lose the POK resume link.
  it("invalid credentials keep a safe next and drop an unsafe one", async () => {
    mockSupabaseAuth.signInWithPassword.mockResolvedValue({
      error: { message: "Invalid login credentials" },
    });
    const resume = "/payments/pok/resume?intent=abc&token=t0k";
    await expectRedirectTo(
      login(formData({ email: "reader@example.com", password: "wrong", next: resume })),
      `/login?error=Invalid%20login%20credentials&next=${encodeURIComponent(resume)}`,
    );
    mockRedirect.mockClear();
    await expectRedirectTo(
      login(formData({ email: "reader@example.com", password: "wrong", next: "//evil.com/phish" })),
      "/login?error=Invalid%20login%20credentials",
    );
    expect(mockRedirect.mock.calls[0][0]).not.toContain("next=");
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
// AUTH-1E: signup() previously called signUp() with no emailRedirectTo
// at all -- an asymmetry with requestPasswordReset()'s own explicit
// redirectTo, and part of the root-cause investigation into why signup
// confirmation links have appeared broken since the project's own
// inception. Now explicitly targets /auth/callback, the same route
// recovery already uses.
describe("signup: emailRedirectTo (AUTH-1E)", () => {
  beforeEach(resetMocks);

  it("passes emailRedirectTo pointing at /auth/callback", async () => {
    await expectRedirectTo(
      signup(
        formData({
          email: "newauthor@example.com",
          password: "hunter2",
          displayName: "New Author",
          role: "reader",
          accept_terms: "on",
        }),
      ),
      "/",
    );

    expect(mockSupabaseAuth.signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          emailRedirectTo: expect.stringContaining("/auth/callback"),
        }),
      }),
    );
  });
});

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
    await expectRedirectTo(signup(signupFormData({ role: "author", confirm_author_age: "on" })), "/dashboard");
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
      "/signup?error=Duhet%20t%C3%AB%20pranoni%20Kushtet%20e%20p%C3%ABrdorimit%20para%20se%20t%C3%AB%20krijoni%20llogarin%C3%AB.",
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
    await expectRedirectTo(signup(signupFormData({ role: "author", confirm_author_age: "on" })), "/dashboard");
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

// PEN-2 (N3): the signup name becomes the display name and, for an
// author, the public author name and default pen name, so it is trimmed.
// A name that is only whitespace gets the profile page's own message.
describe("signup: N3 name trim", () => {
  beforeEach(resetMocks);

  function signupFormData(overrides: Record<string, string> = {}) {
    return formData({
      email: "newauthor@example.com",
      password: "hunter2",
      displayName: "New Author",
      role: "author",
      accept_terms: "on",
      confirm_author_age: "on",
      ...overrides,
    });
  }

  it("sends the trimmed name to signUp", async () => {
    await expectRedirectTo(signup(signupFormData({ displayName: "  Ana Pen \t" })), "/dashboard");
    expect(mockSupabaseAuth.signUp).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ data: { display_name: "Ana Pen" } }),
      }),
    );
    // SECURITY-9A: the trimmed name is also the new author's public name.
    expect(roleWrites[0]?.values).toEqual({ role: "author", public_author_name: "Ana Pen" });
  });

  it.each(["   ", "\t\n"])("refuses a whitespace-only name (%j) before signUp, with the profile page's message", async (name) => {
    await expectRedirectTo(signup(signupFormData({ displayName: name })), "/signup?error=Emri%20nuk%20mund%20t%C3%AB%20jet%C3%AB%20bosh.");
    expect(mockSupabaseAuth.signUp).not.toHaveBeenCalled();
  });

  it("an absent name is still 'Plotësoni të gjitha fushat.'", async () => {
    await expectRedirectTo(signup(signupFormData({ displayName: "" })), "/signup?error=Plot%C3%ABsoni%20t%C3%AB%20gjitha%20fushat.");
    expect(mockSupabaseAuth.signUp).not.toHaveBeenCalled();
  });

  // B2: the name becomes the public author name (at most 120 characters
  // in the database), so a longer one is refused before signUp.
  it("refuses a name over 120 characters before signUp", async () => {
    await expectRedirectTo(
      signup(signupFormData({ displayName: "x".repeat(121) })),
      `/signup?error=${encodeURIComponent("Emri mund të ketë deri në 120 karaktere")}`,
    );
    expect(mockSupabaseAuth.signUp).not.toHaveBeenCalled();
  });

  it("accepts a name of exactly 120 characters, counted after trimming", async () => {
    const exactly120 = "x".repeat(120);
    await expectRedirectTo(signup(signupFormData({ displayName: `  ${exactly120}  ` })), "/dashboard");
    expect(roleWrites[0]?.values).toEqual({ role: "author", public_author_name: exactly120 });
  });
});

// AUTHOR-AGE-1 (Renato 10-24, "6. a"): an author sign-up needs the
// "I'm 18 or older" tick, checked here before signUp(), and the new
// account gets the confirmation in its app_metadata. Reader sign-ups
// are untouched.
describe("signup: AUTHOR-AGE-1 18+ tick", () => {
  beforeEach(resetMocks);

  const NEW_ID = "44444444-4444-4444-8444-444444444444";
  const AGE_ERROR = `/signup?role=author&error=${encodeURIComponent("Autorët duhet të jenë 18 vjeç ose më shumë. Shënoni kutinë për ta konfirmuar.")}`;

  function signupFormData(overrides: Record<string, string> = {}) {
    return formData({
      email: "newauthor@example.com",
      password: "hunter2",
      displayName: "New Author",
      role: "author",
      accept_terms: "on",
      confirm_author_age: "on",
      ...overrides,
    });
  }

  function created(session: unknown) {
    return { data: { session, user: { id: NEW_ID, identities: [{ id: "identity-1" }] } }, error: null };
  }

  it.each([
    ["no tick", undefined],
    ["a tick with another value", "yes"],
  ])("author with %s: refused with the age message (Author kept chosen), signUp never called", async (_label, value) => {
    const fd = signupFormData();
    if (value === undefined) fd.delete("confirm_author_age");
    else fd.set("confirm_author_age", value);
    await expectRedirectTo(signup(fd), AGE_ERROR);
    expect(mockSupabaseAuth.signUp).not.toHaveBeenCalled();
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it("a reader needs no tick, and no 18+ confirmation is recorded (SECURITY-9A: the Terms date is)", async () => {
    const fd = signupFormData({ role: "reader" });
    fd.delete("confirm_author_age");
    mockSupabaseAuth.signUp.mockResolvedValue(created({ access_token: "tok" }));
    await expectRedirectTo(signup(fd), "/");
    expect(mockSupabaseAuth.signUp).toHaveBeenCalledOnce();
    expect(mockUpdateUserById).toHaveBeenCalledOnce();
    const [, attributes] = mockUpdateUserById.mock.calls[0] as [string, { app_metadata: Record<string, unknown> }];
    expect(Object.keys(attributes.app_metadata).sort()).toEqual(["terms_accepted_at", "terms_version"]);
  });

  it.each([
    ["an immediate session", { access_token: "tok" }, "/dashboard"],
    ["email confirmation pending", null, "/signup/check-email"],
  ])("an author with the tick and %s: the new account's app_metadata gets the confirmation", async (_label, session, target) => {
    mockSupabaseAuth.signUp.mockResolvedValue(created(session));
    await expectRedirectTo(signup(signupFormData()), target);
    expect(mockUpdateUserById).toHaveBeenCalledOnce();
    const [id, attributes] = mockUpdateUserById.mock.calls[0] as [string, { app_metadata: Record<string, unknown> }];
    expect(id).toBe(NEW_ID);
    expect(Object.keys(attributes)).toEqual(["app_metadata"]);
    expect(attributes.app_metadata.author_age_statement_version).toBe("author-age-v1");
    expect(Number.isNaN(Date.parse(String(attributes.app_metadata.author_age_confirmed_at)))).toBe(false);
    // SECURITY-9A: the same write carries the Terms record.
    expect(attributes.app_metadata.terms_version).toBe("terms-2026-10");
    expect(attributes.app_metadata.terms_accepted_at).toBe(attributes.app_metadata.author_age_confirmed_at);
  });

  it("an address that already has an account (stand-in user, no identities) is never written", async () => {
    mockSupabaseAuth.signUp.mockResolvedValue({
      data: { session: null, user: { id: NEW_ID, identities: [] } },
      error: null,
    });
    await expectRedirectTo(signup(signupFormData()), "/signup/check-email");
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it("a signUp error records nothing", async () => {
    mockSupabaseAuth.signUp.mockResolvedValue({ data: { session: null, user: null }, error: { message: "User already registered" } });
    await expectRedirectTo(signup(signupFormData()), "/signup?error=User%20already%20registered");
    expect(mockUpdateUserById).not.toHaveBeenCalled();
  });

  it("a failed record is logged without the id; the sign-up finishes as a reader (SECURITY-9A: never switched)", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpdateUserById.mockResolvedValueOnce({ data: null, error: { status: 500, message: "down" } });
    mockSupabaseAuth.signUp.mockResolvedValue(created({ access_token: "tok" }));
    await expectRedirectTo(signup(signupFormData()), "/account?error=");
    expect(roleWrites).toHaveLength(0);
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain(NEW_ID);
    logged.mockRestore();
  });
});

// SECURITY-9A (pipeline item 9, Renato 10-24, all "a"): the database
// makes every new account a reader and ignores any role a sign-up
// sends. signup() sends none, records the Terms tick on every account
// it really creates, and switches an author sign-up to author with the
// author-role writer, only after the 18+ record. A failed switch leaves
// a reader, who is told to use "Become an author".
describe("signup: SECURITY-9A server-side switch to author", () => {
  beforeEach(resetMocks);

  function signupFormData(overrides: Record<string, string> = {}) {
    return formData({
      email: "newauthor@example.com",
      password: "hunter2",
      displayName: " New Author ",
      role: "author",
      accept_terms: "on",
      confirm_author_age: "on",
      ...overrides,
    });
  }

  function lastRedirect() {
    return mockRedirect.mock.calls.at(-1)?.[0];
  }

  it.each(["author", "reader"])("a %s sign-up sends no role to signUp", async (role) => {
    await expect(signup(signupFormData({ role }))).rejects.toBeInstanceOf(RedirectSignal);
    const [args] = mockSupabaseAuth.signUp.mock.calls[0] as unknown as [{ options: { data: Record<string, unknown> } }];
    expect(args.options.data).toEqual({ display_name: "New Author" });
  });

  it.each([
    ["an immediate session", { access_token: "tok" }, "/dashboard"],
    ["email confirmation pending", null, "/signup/check-email"],
  ])("an author with %s is switched: reader -> author, own row only, after the record", async (_label, session, target) => {
    mockSupabaseAuth.signUp.mockResolvedValue(createdUser(session));
    await expect(signup(signupFormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(lastRedirect()).toBe(target);
    expect(roleWrites).toEqual([
      {
        table: "profiles",
        values: { role: "author", public_author_name: "New Author" },
        filters: [
          ["id", CREATED_ID],
          ["role", "reader"],
        ],
        columns: "id, role",
      },
    ]);
    expect(order).toEqual(["record", "switch"]);
  });

  it("a reader sign-up is never switched", async () => {
    await expect(signup(signupFormData({ role: "reader" }))).rejects.toBeInstanceOf(RedirectSignal);
    expect(lastRedirect()).toBe("/");
    expect(roleWrites).toHaveLength(0);
    expect(order).toEqual(["record"]);
  });

  it.each([
    ["an error", { data: null, error: { code: "42501" } }],
    ["no row", { data: [], error: null }],
    ["two rows", { data: [{ id: CREATED_ID, role: "author" }, { id: "x", role: "author" }], error: null }],
    ["another row", { data: [{ id: "someone-else", role: "author" }], error: null }],
    ["a row that is not an author", { data: [{ id: CREATED_ID, role: "reader" }], error: null }],
  ])("a switch with %s fails closed: an immediate session goes to Account with the message", async (_label, result) => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    roleWriteResult = result;
    await expect(signup(signupFormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(lastRedirect()).toBe(
      `/account?error=${encodeURIComponent(
        'Llogaria juaj u krijua si llogari lexuesi. Për të botuar, përdorni "Bëhuni autor" në këtë faqe.',
      )}`,
    );
    expect(JSON.stringify(logged.mock.calls)).not.toContain(CREATED_ID);
    logged.mockRestore();
  });

  it("a failed switch with email confirmation pending adds the note to check-email", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    roleWriteResult = { data: [], error: null };
    mockSupabaseAuth.signUp.mockResolvedValue(createdUser(null));
    await expect(signup(signupFormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(lastRedirect()).toBe("/signup/check-email?author=pending");
    logged.mockRestore();
  });

  it("a stand-in user (address already has an account) gets the plain answer: no record, no switch, no note", async () => {
    mockSupabaseAuth.signUp.mockResolvedValue({
      data: { session: null, user: { id: CREATED_ID, identities: [] } },
      error: null,
    });
    await expect(signup(signupFormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(lastRedirect()).toBe("/signup/check-email");
    expect(mockUpdateUserById).not.toHaveBeenCalled();
    expect(roleWrites).toHaveLength(0);
  });

  it("an immediate session without a created user is never sent to the dashboard", async () => {
    mockSupabaseAuth.signUp.mockResolvedValue({ data: { session: { access_token: "tok" }, user: null }, error: null });
    await expect(signup(signupFormData())).rejects.toBeInstanceOf(RedirectSignal);
    expect(lastRedirect()).toMatch(/^\/account\?error=/);
    expect(roleWrites).toHaveLength(0);
  });
});
