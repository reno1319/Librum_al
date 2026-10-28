import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import {
  SITE_LOCK_ENV,
  SITE_LOCK_OPEN_PATHS,
  SITE_UNLOCK_COOKIE,
  SITE_UNLOCK_COOKIE_MAX_AGE_SECONDS,
  siteLockKey,
  siteLockResponse,
} from "@/lib/site-lock";

// Test-only key, 40 characters; never a real one.
const KEY = "TESTONLY-site-lock-key-0123456789abcdefg";
const SHORT_KEY = "TESTONLY-short";

function tokenFor(key: string): string {
  return createHmac("sha256", key).update("librum-site-unlock-v1").digest("hex");
}

function request(path: string, init: { cookie?: string; method?: string } = {}): NextRequest {
  const headers = new Headers();
  if (init.cookie) headers.set("cookie", init.cookie);
  return new NextRequest(new URL(path, "https://librum.al"), { headers, method: init.method ?? "GET" });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("site lock switch", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "   "],
  ])("is off when %s: every path passes", (_label, value) => {
    vi.stubEnv(SITE_LOCK_ENV, value as string);
    expect(siteLockKey()).toBeNull();
    for (const path of ["/", "/admin", "/unlock?key=x", "/api/books/1/download"]) {
      expect(siteLockResponse(request(path))).toBeNull();
    }
  });

  it("is on when the variable holds a value", () => {
    vi.stubEnv(SITE_LOCK_ENV, KEY);
    expect(siteLockKey()).toBe(KEY);
  });
});

describe("locked page", () => {
  it("answers 503 with Retry-After, noindex and no-store", async () => {
    vi.stubEnv(SITE_LOCK_ENV, KEY);
    const response = siteLockResponse(request("/"))!;
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("86400");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("set-cookie")).toBeNull();
    const html = await response.text();
    expect(html).toContain("under construction");
    expect(html).toContain("Librum po ndërtohet. Hapemi së shpejti.");
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain("mailto:support@librum.al");
    expect(html).not.toContain(KEY);
  });

  it.each([
    "/",
    "/books/abc",
    "/admin",
    "/admin/login",
    "/login",
    "/robots.txt",
    "/sitemap.xml",
    "/api/books/abc/download",
    "/payments/pok/return",
    "/api/health/extra",
    "/api/health/db/",
    "/api/health/db/x",
    "/auth/callback/x",
    "/api/payments/pok/webhook/",
  ])("locks %s", (path) => {
    vi.stubEnv(SITE_LOCK_ENV, KEY);
    expect(siteLockResponse(request(path))?.status).toBe(503);
  });

  it("locks Server Action posts too", () => {
    vi.stubEnv(SITE_LOCK_ENV, KEY);
    expect(siteLockResponse(request("/login", { method: "POST" }))?.status).toBe(503);
  });

  it("leaves exactly the five machine routes open", () => {
    vi.stubEnv(SITE_LOCK_ENV, KEY);
    expect([...SITE_LOCK_OPEN_PATHS].sort()).toEqual([
      "/api/health",
      "/api/health/db",
      "/api/internal/payouts/run",
      "/api/payments/pok/webhook",
      "/auth/callback",
    ]);
    for (const path of SITE_LOCK_OPEN_PATHS) {
      expect(siteLockResponse(request(path, { method: "POST" }))).toBeNull();
      expect(siteLockResponse(request(`${path}?code=abc`))).toBeNull();
    }
  });
});

describe("unlock link", () => {
  it("with the right key: 303 to the home page and a 30-day httpOnly cookie", () => {
    vi.stubEnv(SITE_LOCK_ENV, KEY);
    const response = siteLockResponse(request(`/unlock?key=${encodeURIComponent(KEY)}`))!;
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("https://librum.al/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain(`${SITE_UNLOCK_COOKIE}=${tokenFor(KEY)}`);
    expect(cookie).toContain(`Max-Age=${SITE_UNLOCK_COOKIE_MAX_AGE_SECONDS}`);
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toContain(KEY);
  });

  it("does not need the variable trimmed by the visitor", () => {
    vi.stubEnv(SITE_LOCK_ENV, `  ${KEY}\n`);
    expect(siteLockResponse(request(`/unlock?key=${encodeURIComponent(KEY)}`))?.status).toBe(303);
  });

  it.each([
    ["missing", "/unlock"],
    ["empty", "/unlock?key="],
    ["wrong", "/unlock?key=TESTONLY-wrong-key-0123456789abcdefghij"],
    ["one character short", `/unlock?key=${encodeURIComponent(KEY.slice(0, -1))}`],
    ["one character extra", `/unlock?key=${encodeURIComponent(KEY + "x")}`],
    ["wrong case", `/unlock?key=${encodeURIComponent(KEY.toUpperCase())}`],
  ])("with a %s key: the plain locked page, no cookie", (_label, path) => {
    vi.stubEnv(SITE_LOCK_ENV, KEY);
    const response = siteLockResponse(request(path))!;
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("refuses to unlock while the configured key is under 32 characters", () => {
    vi.stubEnv(SITE_LOCK_ENV, SHORT_KEY);
    const response = siteLockResponse(request(`/unlock?key=${SHORT_KEY}`))!;
    expect(response.status).toBe(503);
    expect(response.headers.get("set-cookie")).toBeNull();
    // and a cookie minted for that short key is not honoured either
    const cookie = `${SITE_UNLOCK_COOKIE}=${tokenFor(SHORT_KEY)}`;
    expect(siteLockResponse(request("/", { cookie }))?.status).toBe(503);
  });

  it("accepts a key of exactly 32 characters", () => {
    const key = KEY.slice(0, 32);
    vi.stubEnv(SITE_LOCK_ENV, key);
    expect(siteLockResponse(request(`/unlock?key=${encodeURIComponent(key)}`))?.status).toBe(303);
  });
});

describe("unlock cookie", () => {
  it("lets the browser through everywhere", () => {
    vi.stubEnv(SITE_LOCK_ENV, KEY);
    const cookie = `${SITE_UNLOCK_COOKIE}=${tokenFor(KEY)}`;
    for (const path of ["/", "/admin", "/admin/login", "/api/books/abc/download", "/robots.txt"]) {
      expect(siteLockResponse(request(path, { cookie }))).toBeNull();
    }
  });

  it("stops working once the key changes", () => {
    vi.stubEnv(SITE_LOCK_ENV, KEY);
    const oldCookie = `${SITE_UNLOCK_COOKIE}=${tokenFor("TESTONLY-old-site-lock-key-0123456789abc")}`;
    expect(siteLockResponse(request("/", { cookie: oldCookie }))?.status).toBe(503);
  });

  it.each([
    ["the key itself", KEY],
    ["empty", ""],
    ["not hex", "z".repeat(64)],
    ["too short", tokenFor(KEY).slice(0, 62)],
    ["too long", tokenFor(KEY) + "00"],
    ["upper-case hex", tokenFor(KEY).toUpperCase()],
  ])("rejects a cookie that is %s", (_label, value) => {
    vi.stubEnv(SITE_LOCK_ENV, KEY);
    expect(siteLockResponse(request("/", { cookie: `${SITE_UNLOCK_COOKIE}=${value}` }))?.status).toBe(503);
  });
});
