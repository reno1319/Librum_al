// LAUNCH-1 P1-10: centralizes the "what's our own base URL" resolution
// that used to be duplicated 8 times across this codebase as
// `process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"` --
// Stripe Checkout success/cancel URLs, Stripe Connect account-link
// return/refresh URLs, the password-reset email redirect, and every
// transactional email link (purchase receipts, sale notifications).
//
// The P1-10 audit's original proposal (log-and-fall-back-to-localhost in
// production) was explicitly rejected -- a misconfigured/missing
// NEXT_PUBLIC_SITE_URL in production must FAIL CLOSED (throw, aborting
// whatever operation was about to construct a URL from it) rather than
// silently hand back a `localhost:3000` link inside a real Stripe
// Checkout session, a real password-reset email, or a real purchase
// receipt. Outside production (local dev, tests), a missing value still
// safely defaults to localhost -- there is no real user on the other end
// of that link in those environments.
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

// Returns the canonical origin (scheme + host [+ port], never a
// trailing slash or a path -- URL.origin is defined to already exclude
// both, which is exactly what every call site needs since they all
// build `${origin}/some/path` themselves).
export function resolveSiteOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL;

  if (!configured) {
    if (isProduction()) {
      throw new Error(
        "NEXT_PUBLIC_SITE_URL is not configured in production -- refusing to generate a Stripe Checkout/Connect URL, password-reset link, or email link from a localhost fallback. Set NEXT_PUBLIC_SITE_URL in the production environment.",
      );
    }
    return "http://localhost:3000";
  }

  // A present-but-invalid configured value is a configuration bug, not
  // an "unset" state -- this always throws, in every environment,
  // rather than silently falling back to localhost for a value someone
  // clearly intended to set correctly.
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL is set to a malformed URL ("${configured}") -- refusing to generate a Stripe Checkout/Connect URL, password-reset link, or email link from it.`,
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must use http or https (got "${parsed.protocol}" from "${configured}") -- refusing to generate a Stripe Checkout/Connect URL, password-reset link, or email link from it.`,
    );
  }

  // LAUNCH-1 P1-10 final correction: production specifically requires
  // https -- a plain http origin (even a real, non-local, publicly
  // routable one) would send Stripe redirect URLs, password-reset
  // links, and every transactional email link over an unencrypted
  // connection. http remains accepted OUTSIDE production (the
  // http://localhost:3000 dev default, and any other local http origin
  // a developer configures) -- only production tightens to https-only.
  if (isProduction() && parsed.protocol !== "https:") {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must use https in production (got "${parsed.protocol}" from "${configured}") -- refusing to generate a Stripe Checkout/Connect URL, password-reset link, or email link over an unencrypted connection.`,
    );
  }

  if (isProduction() && LOCALHOST_HOSTNAMES.has(parsed.hostname)) {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL resolves to a localhost address ("${configured}") in production -- refusing to generate a Stripe Checkout/Connect URL, password-reset link, or email link that no real user could ever reach.`,
    );
  }

  // LAUNCH-1 P1-10 final correction: NEXT_PUBLIC_SITE_URL must name
  // exactly the site's origin, nothing more -- every call site
  // concatenates `${origin}/some/path` itself, so a configured value
  // that already carries its own path/query/hash/credentials would
  // silently corrupt every URL built from it (e.g.
  // "https://x.com/foo" + "/books/123" => "https://x.com/foo/books/123",
  // never what any call site intends). Applies in EVERY environment,
  // not just production -- a present-but-invalid shape is a
  // configuration bug regardless of NODE_ENV, the same posture already
  // taken for a malformed value and a non-http(s) protocol above. A
  // bare root pathname ("" or "/", the only two forms an authority-only
  // URL can parse to -- see the two "no path" cases verified directly
  // against the installed URL implementation) is the only pathname
  // accepted; this is also what makes a single trailing slash a no-op
  // rather than a rejection, since "https://x.com/" parses to the exact
  // same pathname ("/") as "https://x.com" with no slash at all.
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must not include a path (got "${configured}") -- it must name only the site's origin; every caller appends its own path.`,
    );
  }

  if (parsed.search !== "") {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must not include query parameters (got "${configured}") -- it must name only the site's origin.`,
    );
  }

  if (parsed.hash !== "") {
    throw new Error(
      `NEXT_PUBLIC_SITE_URL must not include a fragment (got "${configured}") -- it must name only the site's origin.`,
    );
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error(
      "NEXT_PUBLIC_SITE_URL must not include username/password credentials -- it must name only the site's origin.",
    );
  }

  return parsed.origin;
}
