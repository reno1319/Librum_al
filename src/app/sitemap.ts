import type { MetadataRoute } from "next";
import { resolveSiteOrigin } from "@/lib/site-url";

// LIBRUM 2.0 LAUNCH-FIX-1A SEO-2: static public/marketing routes only
// for this pass -- per-entity pages (books/authors/series/bundles) are
// dynamic, and a correct dynamic sitemap needs its own bounded,
// published-only query design (pagination, per-table "is this actually
// public" filtering matching each page's own RLS-backed query) that
// this small reliability pass deliberately doesn't take on. See this
// pass's own report for the explicit follow-up recommendation -- this
// is a conscious scope decision, not an oversight.
//
// /products and /program are intentionally absent: IA-1A (this same
// pass) retired both routes as orphaned, unlinked placeholders. Auth
// pages (/login, /signup, /forgot-password, /reset-password) and every
// private, login-gated route are intentionally absent too -- a sitemap
// is "please index this," not merely "this isn't blocked"; robots.ts
// (also this pass) is what governs crawl access to those.
//
// force-dynamic for the same reason as robots.ts -- resolveSiteOrigin()
// must not run at build time in an environment where
// NEXT_PUBLIC_SITE_URL isn't set (it deliberately throws rather than
// emit a broken URL; see that file's own comment).
export const dynamic = "force-dynamic";

const STATIC_PUBLIC_ROUTES = [
  "",
  "/about",
  "/how-it-works",
  "/pricing",
  "/bookstore",
  "/help",
  "/contact",
  "/terms",
  "/privacy",
];

export default function sitemap(): MetadataRoute.Sitemap {
  const origin = resolveSiteOrigin();

  return STATIC_PUBLIC_ROUTES.map((path) => ({
    url: `${origin}${path}`,
    lastModified: new Date(),
  }));
}
