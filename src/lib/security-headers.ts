// B4 SECURITY HEADERS (Renato, "3. a"): sent on every response through
// next.config.ts headers(). Kept here, outside next.config.ts, so the
// rules can be unit-tested without loading the config (which runs the
// Supabase env guard).
//
// - Framing: no page of Librum may be shown inside another site's frame
//   (clickjacking on checkout, dashboard, admin). Librum itself embeds no
//   page of its own in a frame. X-Frame-Options for older browsers, CSP
//   frame-ancestors for current ones. The CSP header carries ONLY
//   frame-ancestors, so it restricts nothing else.
// - nosniff: the browser never guesses a file's type (a cover or EPUB is
//   never run as a script or page).
// - Referrer-Policy: the browser's own default, stated explicitly, so
//   other sites see only "librum.al", never a full address.
// - Permissions-Policy: Librum uses no camera, microphone or location,
//   and opts out of the browser's ad-interest topics.
//
// Pages whose address can carry a one-time value (the POK return and
// resume pages, the login page holding a `next` with the payment token,
// and the auth callback's code) send no referrer to any other site at
// all. That is "same-origin", NOT "no-referrer": under "no-referrer" a
// browser sends `Origin: null` on a form POST, and the Server Action
// origin check would then refuse the login form.
const SITE_WIDE_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
];

const SENSITIVE_ADDRESS_SOURCES = ["/login", "/payments/:path*", "/auth/:path*"];

// Later rules win for the same header key (Next's documented order), so
// the stricter Referrer-Policy comes after the site-wide one.
export const SECURITY_HEADER_RULES = [
  { source: "/:path*", headers: SITE_WIDE_HEADERS },
  ...SENSITIVE_ADDRESS_SOURCES.map((source) => ({
    source,
    headers: [{ key: "Referrer-Policy", value: "same-origin" }],
  })),
];
