// VISITOR STATS (pipeline item 6, Renato 10-24): page-visit counts with
// Vercel Web Analytics, which sets no cookies. Pure on purpose, like
// src/lib/protected-staging.ts: the environment and the event come in
// as arguments, so every branch is testable with literal values.

// 1. a: counted only on Production (librum.al). Staging and preview
// builds never load the script, so testing there never shows up in
// the numbers. VERCEL_ENV is set by Vercel's own platform.
export function isVisitorStatsEnabled(env: Record<string, string | undefined>): boolean {
  return env.VERCEL_ENV === "production";
}

// 2. a: only public store pages are counted. This is an ALLOWLIST, so
// a new page stays uncounted until someone adds it here on purpose.
// /admin/* never loads the script at all (it sits outside the
// (public) layout); it is still refused here in case that ever moves.
// Everything else under (public) -- dashboard, account, library,
// wishlist, following, sign-in, sign-up and password pages -- is left
// out so the team's own work and signed-in areas stay out of the
// numbers. visitor-stats.test.ts fails when a (public) folder is in
// neither list, so each new page needs a decision.
export const COUNTED_PATHS = [
  "/about",
  "/authors",
  "/blog",
  "/books",
  "/bookstore",
  "/bundles",
  "/contact",
  "/help",
  "/how-it-works",
  "/pricing",
  "/privacy",
  "/refunds",
  "/series",
  "/terms",
] as const;

export function isCountedPath(pathname: string): boolean {
  if (pathname === "/") return true;
  return COUNTED_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

type VisitEvent = { type: "pageview" | "event"; url: string };

// Runs in the browser before each event is sent. Drops events from
// uncounted pages, and cuts everything after "?" or "#" so search
// words and password-reset codes never leave the site. An address
// that can't be read is dropped rather than sent as-is.
export function prepareVisitEvent<E extends VisitEvent>(event: E): E | null {
  let url: URL;
  try {
    url = new URL(event.url);
  } catch {
    return null;
  }
  if (!isCountedPath(url.pathname)) return null;
  return { ...event, url: `${url.origin}${url.pathname}` };
}
