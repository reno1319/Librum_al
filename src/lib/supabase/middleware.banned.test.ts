import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// PEOPLE-2 audit F1: the REAL @supabase/ssr and auth-js clients (not
// mocked, unlike middleware.test.ts), with only the network stubbed.
// Current Supabase Auth (v2.195+, supabase/auth requireAuthentication)
// answers a banned user's access token with 403 user_banned on GET
// /auth/v1/user, so getUser() returns no user. The middleware must
// still treat that as suspended and end the session.
const REF = "dummyreffortestingx0";
const COOKIE = `sb-${REF}-auth-token`;
const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

type Route = (url: URL, init?: RequestInit) => Response | undefined;
let authUserResponse: () => Response;
const requested: string[] = [];

const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  requested.push(`${init?.method ?? "GET"} ${url.pathname}`);
  const routes: Route[] = [
    (u) => (u.pathname === "/auth/v1/user" ? authUserResponse() : undefined),
    (u) => (u.pathname === "/rest/v1/rpc/my_account_is_suspended" ? Response.json(false) : undefined),
  ];
  for (const route of routes) {
    const response = route(url, init);
    if (response) return response;
  }
  return new Response("not stubbed", { status: 500 });
});

function sessionCookie(): string {
  const b64 = (value: string) => Buffer.from(value).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `${b64(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64(
    JSON.stringify({ sub: USER_ID, exp, role: "authenticated", aud: "authenticated", session_id: "s1" }),
  )}.signature`;
  const session = {
    access_token: jwt,
    refresh_token: "refresh-1",
    expires_at: exp,
    expires_in: 3600,
    token_type: "bearer",
    user: { id: USER_ID, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-01T00:00:00Z" },
  };
  return `base64-${b64(JSON.stringify(session))}`;
}

// Supabase Auth's HTTPError body for this refusal, with the API-version
// header supabase-js negotiates; the second shape is a body carrying the
// code under `code` (auth-js reads either).
const BANNED_BODIES = [
  { code: 403, error_code: "user_banned", msg: "User is banned" },
  { code: "user_banned", message: "User is banned" },
];

let updateSession: (request: NextRequest) => Promise<Response & { cookies: { get(n: string): { value: string; maxAge?: number } | undefined } }>;

beforeAll(async () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-test");
  vi.stubGlobal("fetch", fetchStub);
  ({ updateSession } = (await import("./middleware")) as never);
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  requested.length = 0;
  fetchStub.mockClear();
});

function request(pathname: string, init?: { method?: string; headers?: Record<string, string> }): NextRequest {
  const req = new NextRequest(`https://librumal.vercel.app${pathname}`, init);
  req.cookies.set(COOKIE, sessionCookie());
  return req;
}

describe("updateSession against the real auth client (PEOPLE-2 F1)", () => {
  for (const body of BANNED_BODIES) {
    it(`a 403 user_banned from /auth/v1/user ends the session (body ${JSON.stringify(body)})`, async () => {
      authUserResponse = () =>
        Response.json(body, { status: 403, headers: { "x-supabase-api-version": "2024-01-01" } });
      const response = await updateSession(request("/dashboard"));
      expect(requested).toContain("GET /auth/v1/user");
      const location = new URL(response.headers.get("location")!);
      expect(location.pathname + location.search).toBe("/login?suspended=1");
      expect(response.cookies.get(COOKIE)?.value).toBe("");
      expect(response.cookies.get(COOKIE)?.maxAge).toBe(0);
      // No signOut: /logout is refused for a banned token the same way.
      expect(requested.some((r) => r.includes("/logout"))).toBe(false);
      expect(requested.some((r) => r.includes("my_account_is_suspended"))).toBe(false);
    });
  }

  it("a server action from a banned session gets a 403", async () => {
    authUserResponse = () => Response.json(BANNED_BODIES[0], { status: 403, headers: { "x-supabase-api-version": "2024-01-01" } });
    const response = await updateSession(request("/dashboard", { method: "POST", headers: { "next-action": "abc" } }));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe("This account is suspended. Contact support@librum.al.");
    expect(response.cookies.get(COOKIE)?.maxAge).toBe(0);
  });

  it("any other getUser() refusal (an expired or bad token) is left to the pages, as before", async () => {
    authUserResponse = () =>
      Response.json({ code: 403, error_code: "bad_jwt", msg: "invalid JWT" }, { status: 403, headers: { "x-supabase-api-version": "2024-01-01" } });
    const response = await updateSession(request("/dashboard"));
    expect(response.headers.get("location")).toBeNull();
    expect(response.status).toBe(200);
  });

  it("a valid, unsuspended session passes through after the RPC check", async () => {
    authUserResponse = () => Response.json({ id: USER_ID, aud: "authenticated", role: "authenticated", app_metadata: {}, user_metadata: {}, created_at: "2026-10-01T00:00:00Z" });
    const response = await updateSession(request("/dashboard"));
    expect(requested).toContain("POST /rest/v1/rpc/my_account_is_suspended");
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });
});
