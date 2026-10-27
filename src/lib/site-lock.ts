import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { SUPPORT_EMAIL } from "@/lib/contact";

// UNDER CONSTRUCTION (Renato 10-27, 1a): while the SITE_LOCK_KEY
// environment variable holds a value, every visitor gets the "Under
// construction" page instead of the site. Visiting
// /unlock?key=<that value> once sets a 30-day cookie that lets that
// browser through. Deleting the variable (and redeploying -- Vercel only
// applies env changes to new deployments) switches the page off with no
// code change. It must be off before the POK review.
//
// The key lives only in Vercel's env (Production only), never in this
// public repo. Proxy runs on the Node.js runtime in this Next.js version
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md
// "Runtime"), so node:crypto is available.
export const SITE_LOCK_ENV = "SITE_LOCK_KEY";

// A short key is guessable from the outside, so the page stays on but
// the unlock link refuses to work until the key is long enough
// (fail closed: a typo can never open the site).
export const SITE_LOCK_MIN_KEY_LENGTH = 32;

export const SITE_UNLOCK_PATH = "/unlock";
export const SITE_UNLOCK_COOKIE = "librum_site_unlock";
export const SITE_UNLOCK_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

// One day: tells Google this is temporary, so it comes back later.
export const SITE_LOCK_RETRY_AFTER_SECONDS = 86400;

// Machine routes that must keep working for everyone (2a): POK's
// server-to-server webhook, the monthly payout job (vercel.json, guarded
// by its own CRON_SECRET), the liveness check and the uptime monitor's
// database check (ALERTS-1, 2a: returns only ok or not ok), and the email
// confirm/login callback (it only exchanges a code, then redirects to a
// page, which is locked again without the cookie). Exact paths only --
// no prefixes, so nothing new opens up by accident.
export const SITE_LOCK_OPEN_PATHS: ReadonlySet<string> = new Set([
  "/api/payments/pok/webhook",
  "/api/internal/payouts/run",
  "/api/health",
  "/api/health/db",
  "/auth/callback",
]);

// Empty or whitespace-only counts as unset, so clearing the value in
// Vercel switches the page off just like deleting the variable.
export function siteLockKey(): string | null {
  const value = process.env[SITE_LOCK_ENV]?.trim();
  return value ? value : null;
}

// The cookie never holds the key itself: it holds an HMAC of a fixed
// label under the key. Changing the key therefore logs every unlocked
// browser out, and a leaked cookie never reveals the key.
function unlockToken(key: string): Buffer {
  return createHmac("sha256", key).update("librum-site-unlock-v1").digest();
}

// Constant-time: both sides are hashed to the same length first, so
// timingSafeEqual never sees different lengths and nothing leaks how
// much of a guess was right.
function sameKey(candidate: string, key: string): boolean {
  const a = createHmac("sha256", "librum-site-unlock-compare").update(candidate).digest();
  const b = createHmac("sha256", "librum-site-unlock-compare").update(key).digest();
  return timingSafeEqual(a, b);
}

function hasValidCookie(request: NextRequest, key: string): boolean {
  const value = request.cookies.get(SITE_UNLOCK_COOKIE)?.value;
  if (!value || !/^[0-9a-f]{64}$/.test(value)) return false;
  return timingSafeEqual(Buffer.from(value, "hex"), unlockToken(key));
}

const LOCKED_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Librum is under construction</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f7f3ea; color: #1c2420; font-family: Georgia, "Times New Roman", serif; }
  main { max-width: 32rem; padding: 2rem 1.5rem; text-align: center; }
  h1 { margin: 0 0 1rem; font-size: 2.25rem; color: #1e3a32; }
  p { margin: 0 0 0.75rem; font-size: 1.125rem; line-height: 1.6; color: #4c5751; }
  a { color: #1e3a32; }
</style>
</head>
<body>
<main>
<h1>Librum</h1>
<p>Our site is under construction. We open soon.</p>
<p lang="sq">Librum po ndërtohet. Hapemi së shpejti.</p>
<p><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></p>
</main>
</body>
</html>
`;

export function lockedPageResponse(): NextResponse {
  return new NextResponse(LOCKED_PAGE_HTML, {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": String(SITE_LOCK_RETRY_AFTER_SECONDS),
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

// The proxy's first step. Returns the response to send instead of the
// site, or null when the request goes through as normal.
export function siteLockResponse(request: NextRequest): NextResponse | null {
  const key = siteLockKey();
  if (!key) return null;

  const { pathname } = request.nextUrl;
  if (SITE_LOCK_OPEN_PATHS.has(pathname)) return null;

  if (pathname === SITE_UNLOCK_PATH) {
    const candidate = request.nextUrl.searchParams.get("key") ?? "";
    // Wrong or missing key: the same page as everyone else, no hint.
    if (key.length < SITE_LOCK_MIN_KEY_LENGTH || !sameKey(candidate, key)) {
      return lockedPageResponse();
    }
    // 303 to the home page so the key leaves the address bar at once.
    const response = NextResponse.redirect(new URL("/", request.url), 303);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    response.cookies.set(SITE_UNLOCK_COOKIE, unlockToken(key).toString("hex"), {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SITE_UNLOCK_COOKIE_MAX_AGE_SECONDS,
    });
    return response;
  }

  if (key.length >= SITE_LOCK_MIN_KEY_LENGTH && hasValidCookie(request, key)) return null;

  return lockedPageResponse();
}
