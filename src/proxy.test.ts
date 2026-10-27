import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { NextRequest, NextResponse } from "next/server";
// This Next.js version ships the helper under its old Middleware name (the
// proxy.md docs call it unstable_doesProxyMatch, which is not exported).
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";

const mockUpdateSession = vi.fn((_request: NextRequest) => Promise.resolve(NextResponse.next()));
vi.mock("@/lib/supabase/middleware", () => ({
  updateSession: (request: NextRequest) => mockUpdateSession(request),
}));

const { proxy, config } = await import("@/proxy");

// Test-only key; never a real one.
const KEY = "TESTONLY-site-lock-key-0123456789abcdefg";

afterEach(() => {
  vi.unstubAllEnvs();
  mockUpdateSession.mockClear();
});

describe("proxy and the site lock", () => {
  it("runs the session refresh as before when the lock is off", async () => {
    vi.stubEnv("SITE_LOCK_KEY", "");
    const response = await proxy(new NextRequest("https://librum.al/"));
    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
  });

  it("answers a locked visitor without touching the session refresh", async () => {
    vi.stubEnv("SITE_LOCK_KEY", KEY);
    const response = await proxy(new NextRequest("https://librum.al/admin"));
    expect(response.status).toBe(503);
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });

  it("still refreshes the session on an open machine route", async () => {
    vi.stubEnv("SITE_LOCK_KEY", KEY);
    await proxy(new NextRequest("https://librum.al/auth/callback?code=abc"));
    expect(mockUpdateSession).toHaveBeenCalledTimes(1);
  });
});

// UNDER CONSTRUCTION r2 (audit F1): which paths Proxy runs on, checked
// with Next's own matcher logic rather than a copy of the regex.
const runsProxy = (url: string) => unstable_doesMiddlewareMatch({ config, url });

// Every file in public/, as the URL it is served at. Kept by hand on
// purpose: the test below fails when public/ changes, so the matcher's
// exact-path list gets updated in the same patch.
const PUBLIC_FILES = [
  "/file.svg",
  "/globe.svg",
  "/images/author-hero.jpg",
  "/next.svg",
  "/vercel.svg",
  "/window.svg",
];

function listPublic(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listPublic(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

describe("proxy matcher", () => {
  it("PUBLIC_FILES is exactly what public/ holds", () => {
    const root = join(process.cwd(), "public");
    const onDisk = listPublic(root).map((file) => `/${relative(root, file).split("\\").join("/")}`);
    expect(onDisk.sort()).toEqual([...PUBLIC_FILES].sort());
  });

  it.each([...PUBLIC_FILES, "/favicon.ico", "/_next/static/chunks/app.js", "/_next/static/media/font.woff2", "/_next/image?url=%2Fimages%2Fauthor-hero.jpg&w=640&q=75"])(
    "skips the real static file %s",
    (url) => {
      expect(runsProxy(url)).toBe(false);
    },
  );

  it.each([
    "/",
    "/books/x.png",
    "/books/x.svg",
    "/authors/x.webp",
    "/admin/books/x.jpg",
    "/x.png",
    "/x.gif",
    "/x.jpeg",
    "/faviconXico",
    "/favicon.ico/x",
    "/_next/staticfoo",
    "/_next/imagefoo",
    "/_next/image/x",
    "/images/other.jpg",
    "/images/author-hero.jpgx",
    "/images/author-hero.jpg/x",
    "/books/next.svg",
    "/nextXsvg",
    "/unlock",
    "/api/health",
  ])("runs on %s", (url) => {
    expect(runsProxy(url)).toBe(true);
  });

  it("locks an image-looking page path, GET and Server Action POST alike", async () => {
    vi.stubEnv("SITE_LOCK_KEY", KEY);
    expect(runsProxy("/books/x.png")).toBe(true);
    const get = await proxy(new NextRequest("https://librum.al/books/x.png"));
    expect(get.status).toBe(503);
    const post = await proxy(
      new NextRequest("https://librum.al/books/x.png", {
        method: "POST",
        headers: { "next-action": "0123456789abcdef0123456789abcdef01234567" },
      }),
    );
    expect(post.status).toBe(503);
    expect(post.headers.get("x-action-redirect")).toBeNull();
    expect((await proxy(new NextRequest("https://librum.al/faviconXico"))).status).toBe(503);
    expect(mockUpdateSession).not.toHaveBeenCalled();
  });
});
