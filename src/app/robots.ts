import type { MetadataRoute } from "next";
import { resolveSiteOrigin } from "@/lib/site-url";

// LIBRUM 2.0 LAUNCH-FIX-1A SEO-2: confirmed absent before this pass --
// nothing disallowed /dashboard, /account, or /admin, so crawlers could
// reach and index their own redirect-to-/login chain (wasted crawl
// budget) even though none of the actual private content behind them
// was ever reachable without a session. robots.txt is NOT access
// control -- every one of these routes already re-checks auth/role
// server-side regardless of what a crawler is told here (see
// src/lib/auth.ts's requireAdmin(), src/app/dashboard/layout.tsx) --
// this only asks well-behaved crawlers not to bother.
//
// Deliberately no trailing slash on most private-route prefixes below
// (e.g. "/dashboard", not "/dashboard/") -- robots.txt Disallow is a
// literal path-PREFIX match, so a trailing slash would fail to cover
// the bare route itself (e.g. "/dashboard/" does not match "/dashboard"
// with nothing after it), only its sub-paths. Dropping the slash
// covers both the exact top-level page and everything under it with
// one entry.
//
// "/auth/" is the one deliberate exception, and DOES keep its trailing
// slash -- there is no bare "/auth" page (only "/auth/callback", an
// internal route handler), and a bare "/auth" prefix would also match
// the fully public "/authors/[id]" pages ("/authors" starts with the
// literal string "/auth"). Confirmed by reading the route inventory
// before writing this, not assumed.
//
// force-dynamic: this file has no Request-time API of its own (reading
// process.env is not one), so by Next's default caching rules it would
// otherwise be evaluated once at BUILD time -- and resolveSiteOrigin()
// deliberately throws in production if NEXT_PUBLIC_SITE_URL isn't set
// (see that file's own comment: fail closed, never emit a broken
// Stripe/email/robots URL). Forcing this dynamic defers that call to
// request time, matching how every other resolveSiteOrigin() caller in
// this codebase already runs (Server Actions, never build-time code).
export const dynamic = "force-dynamic";

const DISALLOWED_PREFIXES = [
  "/dashboard",
  "/account",
  "/admin",
  "/auth/",
  "/library",
  "/wishlist",
  "/following",
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: DISALLOWED_PREFIXES,
    },
    sitemap: `${resolveSiteOrigin()}/sitemap.xml`,
  };
}
