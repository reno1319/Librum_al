import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { RECOVERY_COOKIE_NAME, RECOVERY_COOKIE_TTL_SECONDS } from "@/lib/recovery-session";
import { INTERNAL_PATHNAME_HEADER } from "@/lib/internal-headers";

// LAUNCH-1 P1-11: mocks only the network boundary (@supabase/ssr's own
// createServerClient, which would otherwise try a real HTTP call via
// auth.getUser()) -- NextRequest/NextResponse are used for real, not
// faked, since they're plain constructible classes outside an actual
// server context (confirmed directly: `new NextRequest(url)` and
// `NextResponse.redirect(...)` both work under plain Vitest). This is
// deliberately NOT the "heavier, less-honest harness" src/lib/auth.test.ts's
// own comment warns against for requireAdmin() -- that case would have
// mocked away real Supabase auth/RLS semantics this codebase actually
// depends on; here the recovery redirect decision itself
// (shouldRedirectForRecovery, tested directly and thoroughly in
// recovery-session.test.ts) is the only real logic, and this file's
// job is proving the Next.js-specific plumbing around it -- URL
// construction, cookie propagation, and matcher-independent behavior --
// actually works, which nothing else exercises.
const mockGetUser = vi.fn(() => Promise.resolve({ data: { user: null }, error: null }));

// LAUNCH-1 P1-11 SLIDING-LIFETIME CORRECTION: when true, the mocked
// getUser() also invokes the real `setAll` callback middleware.ts passed
// to createServerClient() -- simulating exactly what the real
// @supabase/ssr SDK does on a TOKEN_REFRESHED event (traced directly in
// node_modules/@supabase/ssr/dist/module/cookies.js's
// applyServerStorage(): it calls setAll with a freshly-issued
// DEFAULT_COOKIE_OPTIONS.maxAge). Lets tests below prove the recovery
// marker's own renewal is unconditional -- not merely coincidentally
// correlated with whether this particular request happened to trigger a
// Supabase-side refresh.
let simulateAuthCookieRefresh = false;

// PEOPLE-2: the suspension check's two calls. By default the account is
// not suspended; signOut() clears the session cookie through setAll, as
// the real client does.
const mockRpc = vi.fn((_fn: string): Promise<{ data: unknown; error: unknown }> =>
  Promise.resolve({ data: false, error: null }),
);
const mockSignOut = vi.fn((_options: unknown): Promise<{ error: unknown }> => Promise.resolve({ error: null }));
let signOutClearsCookie = true;

vi.mock("@supabase/ssr", () => ({
  createServerClient: (_url: string, _key: string, options: { cookies: { setAll: (c: unknown[]) => void } }) => ({
    auth: {
      getUser: async () => {
        if (simulateAuthCookieRefresh) {
          options.cookies.setAll([
            {
              name: "sb-project-auth-token",
              value: "refreshed-session-value",
              options: { httpOnly: true, path: "/", maxAge: 400 * 24 * 60 * 60 },
            },
          ]);
        }
        return mockGetUser();
      },
      signOut: async (signOutOptions: unknown) => {
        if (signOutClearsCookie) {
          options.cookies.setAll([{ name: "sb-project-auth-token", value: "", options: { path: "/", maxAge: 0 } }]);
        }
        return mockSignOut(signOutOptions);
      },
    },
    rpc: (fn: string) => mockRpc(fn),
  }),
}));

const { updateSession } = await import("./middleware");

function makeRequest(pathname: string, cookies: Record<string, string> = {}): NextRequest {
  const request = new NextRequest(`https://librumal.vercel.app${pathname}`);
  for (const [name, value] of Object.entries(cookies)) {
    request.cookies.set(name, value);
  }
  return request;
}

describe("updateSession: password-recovery containment", () => {
  beforeEach(() => {
    mockGetUser.mockClear();
    simulateAuthCookieRefresh = false;
  });

  it("ordinary authenticated request (no recovery cookie) passes through unaffected", async () => {
    const response = await updateSession(makeRequest("/library"));
    expect(response.headers.get("location")).toBeNull();
  });

  it("recovery cookie + /library redirects to /reset-password", async () => {
    const response = await updateSession(
      makeRequest("/library", { [RECOVERY_COOKIE_NAME]: "1" }),
    );
    expect(new URL(response.headers.get("location")!).pathname).toBe("/reset-password");
  });

  it("recovery cookie + /dashboard/payouts redirects to /reset-password", async () => {
    const response = await updateSession(
      makeRequest("/dashboard/payouts", { [RECOVERY_COOKIE_NAME]: "1" }),
    );
    expect(new URL(response.headers.get("location")!).pathname).toBe("/reset-password");
  });

  it("recovery cookie + /admin/refunds redirects to /reset-password", async () => {
    const response = await updateSession(
      makeRequest("/admin/refunds", { [RECOVERY_COOKIE_NAME]: "1" }),
    );
    expect(new URL(response.headers.get("location")!).pathname).toBe("/reset-password");
  });

  it("recovery cookie + /reset-password is allowed -- no redirect loop", async () => {
    const response = await updateSession(
      makeRequest("/reset-password", { [RECOVERY_COOKIE_NAME]: "1" }),
    );
    expect(response.headers.get("location")).toBeNull();
  });

  it("recovery cookie + /auth/callback is allowed (a second/replayed recovery link must still work)", async () => {
    const response = await updateSession(
      makeRequest("/auth/callback", { [RECOVERY_COOKIE_NAME]: "1" }),
    );
    expect(response.headers.get("location")).toBeNull();
  });

  it("recovery cookie + /login is allowed (updatePassword's own success redirect target)", async () => {
    const response = await updateSession(
      makeRequest("/login", { [RECOVERY_COOKIE_NAME]: "1" }),
    );
    expect(response.headers.get("location")).toBeNull();
  });

  it("a cookie with the recovery name but the wrong value is NOT treated as active recovery", async () => {
    const response = await updateSession(
      makeRequest("/library", { [RECOVERY_COOKIE_NAME]: "not-the-real-value" }),
    );
    expect(response.headers.get("location")).toBeNull();
  });

  // LAUNCH-1 P1-11 CORRECTION: proves "revisiting/multiple refreshes
  // does not drop recovery containment" -- updateSession() calls
  // supabase.auth.getUser() (mocked here) on every single request,
  // which is exactly what triggers a real token refresh (and, in
  // production, re-issues the Supabase session cookie's own Set-Cookie
  // with a fresh maxAge). Nothing in updateSession() ever reads,
  // writes, or clears the recovery cookie except the
  // shouldRedirectForRecovery check itself -- repeating the same
  // request many times (simulating many refresh cycles / repeated
  // visits) must keep producing the identical redirect, never let it
  // silently lapse partway through.
  it("repeated requests carrying the recovery cookie (simulating multiple token-refresh cycles) keep redirecting every time", async () => {
    for (let i = 0; i < 5; i++) {
      mockGetUser.mockClear();
      const response = await updateSession(
        makeRequest("/library", { [RECOVERY_COOKIE_NAME]: "1" }),
      );
      expect(new URL(response.headers.get("location")!).pathname).toBe("/reset-password");
      expect(mockGetUser).toHaveBeenCalledOnce();
    }
  });
});

// LAUNCH-1 P1-11 SLIDING-LIFETIME CORRECTION: proves the recovery
// marker's own maxAge is renewed to a fresh, full RECOVERY_COOKIE_TTL_SECONDS
// on every qualifying response -- the fix for the confirmed defect where
// a one-time-set marker could expire before a Supabase session cookie
// whose OWN maxAge slides forward on every token refresh.
describe("updateSession: recovery marker sliding-lifetime renewal", () => {
  beforeEach(() => {
    mockGetUser.mockClear();
    simulateAuthCookieRefresh = false;
  });

  it("1. an active-recovery request renews the recovery marker's maxAge on the response", async () => {
    const response = await updateSession(
      makeRequest("/reset-password", { [RECOVERY_COOKIE_NAME]: "1" }),
    );
    const cookie = response.cookies.get(RECOVERY_COOKIE_NAME);
    expect(cookie).toBeDefined();
    expect(cookie!.maxAge).toBe(RECOVERY_COOKIE_TTL_SECONDS);
  });

  it("2. repeated requests keep renewing it, every time", async () => {
    for (let i = 0; i < 5; i++) {
      const response = await updateSession(
        makeRequest("/reset-password", { [RECOVERY_COOKIE_NAME]: "1" }),
      );
      expect(response.cookies.get(RECOVERY_COOKIE_NAME)?.maxAge).toBe(RECOVERY_COOKIE_TTL_SECONDS);
    }
  });

  it("3. redirecting /library -> /reset-password also renews the marker (response path B)", async () => {
    const response = await updateSession(
      makeRequest("/library", { [RECOVERY_COOKIE_NAME]: "1" }),
    );
    expect(new URL(response.headers.get("location")!).pathname).toBe("/reset-password");
    expect(response.cookies.get(RECOVERY_COOKIE_NAME)?.maxAge).toBe(RECOVERY_COOKIE_TTL_SECONDS);
  });

  it("4. an allowed /reset-password request (no redirect) also renews the marker (response path A)", async () => {
    const response = await updateSession(
      makeRequest("/reset-password", { [RECOVERY_COOKIE_NAME]: "1" }),
    );
    expect(response.headers.get("location")).toBeNull();
    expect(response.cookies.get(RECOVERY_COOKIE_NAME)?.maxAge).toBe(RECOVERY_COOKIE_TTL_SECONDS);
  });

  it("5. a simulated Supabase auth-cookie refresh cannot produce a response where the auth session is renewed but the recovery marker is not", async () => {
    simulateAuthCookieRefresh = true;
    const response = await updateSession(
      makeRequest("/reset-password", { [RECOVERY_COOKIE_NAME]: "1" }),
    );
    // The simulated Supabase refresh cookie is present (proving the
    // refresh really happened on this response)...
    expect(response.cookies.get("sb-project-auth-token")).toBeDefined();
    // ...and the recovery marker was renewed on the SAME response, not
    // left at whatever maxAge it happened to carry on the request.
    expect(response.cookies.get(RECOVERY_COOKIE_NAME)?.maxAge).toBe(RECOVERY_COOKIE_TTL_SECONDS);
  });

  it("8. an ordinary authenticated request (no recovery cookie) never receives a recovery marker", async () => {
    const response = await updateSession(makeRequest("/library"));
    expect(response.cookies.get(RECOVERY_COOKIE_NAME)).toBeUndefined();
  });

  it("9. a simulated Supabase refresh on an ORDINARY (non-recovery) session does not create a recovery marker", async () => {
    simulateAuthCookieRefresh = true;
    const response = await updateSession(makeRequest("/library"));
    expect(response.cookies.get("sb-project-auth-token")).toBeDefined();
    expect(response.cookies.get(RECOVERY_COOKIE_NAME)).toBeUndefined();
  });

  // Concrete long-lived model: T0 recovery begins, T+300d an ordinary
  // auth refresh happens (well within Supabase's own 400-day sliding
  // window, pushing its effective expiry out toward ~T+700d) -- under
  // the OLD design (marker set once at T0, never renewed) this would
  // leave a Day-400 unlock: the marker gone, the session still valid.
  // This test simulates exactly that T+300d refresh and proves the
  // marker is renewed on the very same response, so no such gap can
  // ever open.
  it("T0 recovery, T+300d auth refresh -> recovery marker renewed too, no Day-400 unlock exists", async () => {
    // T0: recovery begins (src/app/auth/callback/route.ts sets the
    // marker -- not re-modeled here, just its resulting cookie on the
    // simulated T+300d request below).
    // T+300d: an ordinary token refresh occurs on this request.
    simulateAuthCookieRefresh = true;
    const response = await updateSession(
      makeRequest("/library", { [RECOVERY_COOKIE_NAME]: "1" }),
    );

    // Still redirected -- recovery is still active at T+300d.
    expect(new URL(response.headers.get("location")!).pathname).toBe("/reset-password");
    // The marker was renewed to a fresh full TTL on this exact response
    // -- its effective expiry is now T+300d+400d, matching (not
    // trailing) whatever the just-refreshed Supabase session cookie's
    // own new ~T+700d expiry is. No Day-400 gap exists: the marker's
    // clock restarted at the same moment the session's did.
    expect(response.cookies.get(RECOVERY_COOKIE_NAME)?.maxAge).toBe(RECOVERY_COOKIE_TTL_SECONDS);
  });
});

// LIBRUM 2.0 AUTH-2: proves the internal pathname-forwarding behavior
// dashboard/layout.tsx depends on to build its `/login?next=` target.
// NextResponse.next({ request: { headers } }) doesn't expose the
// forwarded request headers as ordinary response headers -- Next.js
// encodes them onto the response as `x-middleware-request-<key>` (see
// node_modules/next/dist/server/web/spec-extension/response.js's
// handleMiddlewareField, traced directly, not assumed) specifically so
// the next hop in the pipeline can reconstruct them. Reading that
// encoded form here is the real, documented mechanism the forwarded
// header actually rides on -- not a stand-in for it.
function forwardedPathname(response: Response): string | null {
  return response.headers.get(`x-middleware-request-${INTERNAL_PATHNAME_HEADER}`);
}

describe("updateSession: internal pathname forwarding (AUTH-2)", () => {
  beforeEach(() => {
    mockGetUser.mockClear();
    simulateAuthCookieRefresh = false;
  });

  it("forwards the real pathname for a normal dashboard route", async () => {
    const response = await updateSession(makeRequest("/dashboard/payouts"));
    expect(forwardedPathname(response)).toBe("/dashboard/payouts");
  });

  it("forwards the real pathname for a dynamic dashboard route", async () => {
    const response = await updateSession(makeRequest("/dashboard/books/abc-123/edit"));
    expect(forwardedPathname(response)).toBe("/dashboard/books/abc-123/edit");
  });

  it("forwards the real pathname for a non-dashboard route too -- forwarding is unconditional, not dashboard-specific", async () => {
    const response = await updateSession(makeRequest("/library"));
    expect(forwardedPathname(response)).toBe("/library");
  });

  it("does not include the query string -- AUTH-2's path-only decision", async () => {
    const request = new NextRequest("https://librumal.vercel.app/dashboard/sales?foo=bar");
    const response = await updateSession(request);
    expect(forwardedPathname(response)).toBe("/dashboard/sales");
  });

  it("a spoofed incoming header is discarded -- the forwarded value is always the request's own real pathname", async () => {
    const request = new NextRequest("https://librumal.vercel.app/dashboard/payouts");
    request.headers.set(INTERNAL_PATHNAME_HEADER, "/admin");
    const response = await updateSession(request);
    expect(forwardedPathname(response)).toBe("/dashboard/payouts");
  });

  it("the header still forwards correctly on a request that also triggers a cookie refresh (setAll rebuilds the response)", async () => {
    simulateAuthCookieRefresh = true;
    const response = await updateSession(makeRequest("/dashboard/series"));
    expect(response.cookies.get("sb-project-auth-token")).toBeDefined();
    expect(forwardedPathname(response)).toBe("/dashboard/series");
  });
});

describe("updateSession: the suspension check (PEOPLE-2)", () => {
  const USER = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
  const SESSION = { "sb-project-auth-token": "session-value", "sb-project-auth-token.1": "chunk" };

  beforeEach(() => {
    simulateAuthCookieRefresh = false;
    signOutClearsCookie = true;
    mockGetUser.mockReset().mockResolvedValue({ data: { user: USER }, error: null } as never);
    mockRpc.mockReset().mockResolvedValue({ data: false, error: null });
    mockSignOut.mockReset().mockResolvedValue({ error: null });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  function expectSessionCleared(response: Response & { cookies: { get(name: string): { value: string; maxAge?: number } | undefined } }) {
    for (const name of Object.keys(SESSION)) {
      const cookie = response.cookies.get(name);
      expect(cookie?.value).toBe("");
      expect(cookie?.maxAge).toBe(0);
    }
  }

  it("anonymous requests are never checked", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null } as never);
    const response = await updateSession(makeRequest("/dashboard"));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(response.headers.get("location")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("a user_banned getUser() error ends the session without signOut (F1; real shape in middleware.banned.test.ts)", async () => {
    mockGetUser.mockResolvedValue({
      data: { user: null },
      error: { name: "AuthApiError", status: 403, code: "user_banned", message: "User is banned" },
    } as never);
    const response = await updateSession(makeRequest("/dashboard", SESSION));
    expect(new URL(response.headers.get("location")!).search).toBe("?suspended=1");
    expectSessionCleared(response);
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("a getUser() error other than user_banned changes nothing (the user is null)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: "boom" } } as never);
    const response = await updateSession(makeRequest("/dashboard", SESSION));
    expect(mockRpc).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
  });

  it("a signed-in, not suspended account passes through", async () => {
    const response = await updateSession(makeRequest("/dashboard", SESSION));
    expect(mockRpc).toHaveBeenCalledWith("my_account_is_suspended");
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("a suspended account is signed out globally, its cookies cleared, and sent to /login?suspended=1", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    const response = await updateSession(makeRequest("/dashboard", SESSION));
    expect(mockSignOut).toHaveBeenCalledWith({ scope: "global" });
    const location = new URL(response.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("suspended")).toBe("1");
    expectSessionCleared(response);
  });

  it("a ban in banned_until is enough on its own (older Supabase Auth)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { ...USER, banned_until: "2126-01-01T00:00:00Z" } }, error: null } as never);
    const response = await updateSession(makeRequest("/library", SESSION));
    expect(mockSignOut).toHaveBeenCalledWith({ scope: "global" });
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("clears the cookies even when signOut() throws or never clears them", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    signOutClearsCookie = false;
    mockSignOut.mockRejectedValue(new Error("network"));
    const response = await updateSession(makeRequest("/dashboard", SESSION));
    expectSessionCleared(response);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });

  it("a server action gets a 403, not a redirect", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    const request = new NextRequest("https://librumal.vercel.app/dashboard", {
      method: "POST",
      headers: { "next-action": "abc123" },
    });
    for (const [name, value] of Object.entries(SESSION)) request.cookies.set(name, value);
    const response = await updateSession(request);
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("This account is suspended. Contact support@librum.al.");
    expectSessionCleared(response);
  });

  it("an /api request gets a 403, not a redirect", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    const response = await updateSession(makeRequest("/api/downloads/abc", SESSION));
    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    expectSessionCleared(response);
  });

  it("fails closed with a 503 when the RPC errors, without signing out", async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: "PGRST000", message: "boom" } });
    const response = await updateSession(makeRequest("/dashboard", SESSION));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("Something went wrong, try again.");
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(response.cookies.get("sb-project-auth-token")).toBeUndefined();
  });

  it("fails closed with a 503 when the RPC throws or returns a non-boolean", async () => {
    mockRpc.mockRejectedValueOnce(new Error("fetch failed"));
    expect((await updateSession(makeRequest("/dashboard", SESSION))).status).toBe(503);
    mockRpc.mockResolvedValueOnce({ data: null, error: null });
    expect((await updateSession(makeRequest("/dashboard", SESSION))).status).toBe(503);
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it("keeps a token refresh from this request on the 503", async () => {
    simulateAuthCookieRefresh = true;
    mockRpc.mockResolvedValue({ data: null, error: { code: "PGRST000" } });
    const response = await updateSession(makeRequest("/dashboard", SESSION));
    expect(response.status).toBe(503);
    expect(response.cookies.get("sb-project-auth-token")?.value).toBe("refreshed-session-value");
  });

  it("runs before the recovery redirect: a suspended recovery session goes to /login", async () => {
    mockRpc.mockResolvedValue({ data: true, error: null });
    const response = await updateSession(makeRequest("/library", { ...SESSION, [RECOVERY_COOKIE_NAME]: "1" }));
    expect(new URL(response.headers.get("location")!).pathname).toBe("/login");
  });
});
