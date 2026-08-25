// LAUNCH-1 P1-11: centralizes ALL recovery-session-restriction state and
// decision logic behind one first-party cookie -- see the P1-11 audit
// for the full trace of why a Supabase password-recovery link produces
// a session indistinguishable from an ordinary login everywhere else in
// this codebase, and why that is the defect this file exists to close.
//
// Deliberately imports NOTHING from next/navigation or next/headers --
// this module is imported by src/lib/supabase/middleware.ts, which
// src/proxy.ts runs on effectively every request. next/navigation's
// redirect() is meaningless outside a Server Component/Action/Route
// Handler render (Proxy uses NextResponse.redirect() instead, a wholly
// different mechanism), so it must never be pulled into this file's
// module graph. See src/lib/recovery-guard.ts for the Server-Action-
// specific defense-in-depth guard, which is deliberately a SEPARATE
// file for exactly this reason.
//
// Deliberately cookie-only, no database state (per the audit's own
// "prefer no database state unless genuinely necessary" conclusion),
// and deliberately NOT cleared merely by TTL expiry or by the browser
// closing -- see the LAUNCH-1 P1-11 CORRECTION on
// RECOVERY_COOKIE_TTL_SECONDS below for why an independently-timed
// marker is itself the exact defect this file exists to avoid. The
// restriction ends only via setRecoverySession()'s counterpart,
// clearRecoverySession() -- called exclusively from a confirmed
// successful password update, an explicit logout, or a confirmed
// successful ORDINARY (non-recovery) authentication establishing a new
// session (a password login, a signup that immediately establishes a
// session, or a non-recovery /auth/callback exchange -- all in
// src/app/auth/actions.ts / src/app/auth/callback/route.ts, LAUNCH-1
// P1-11 STALE-MARKER CORRECTION) -- or by the underlying Supabase
// session itself becoming invalid on its own terms, never by this
// cookie quietly outliving or under-living that session.
//
// The cookie's VALUE carries no information beyond "present or not" --
// it is not a signed token, not a session id, nothing an attacker could
// use even if they somehow read it (they can't -- HttpOnly). The actual
// security property comes entirely from this being a server-set,
// server-cleared, HttpOnly cookie: src/app/auth/callback/route.ts
// (LAUNCH-1 P1-11) originates it on a genuine recovery exchange,
// src/lib/supabase/middleware.ts (LAUNCH-1 P1-11 SLIDING-LIFETIME
// CORRECTION) renews it on every request while it's already active --
// never originates a NEW restriction on its own -- and it is cleared
// from every point in the codebase where an ordinary authenticated
// session is confirmed to exist: src/app/auth/actions.ts's
// updatePassword() (on success), logout(), login() (on success), and
// signup() (on success, only once data.session is truthy), plus
// src/app/auth/callback/route.ts's own non-recovery success branch
// (LAUNCH-1 P1-11 STALE-MARKER CORRECTION, all four).
export const RECOVERY_COOKIE_NAME = "librum-recovery";

// LAUNCH-1 P1-11 CORRECTION -- CRITICAL: this was originally 15 minutes
// ("generous enough to read an email, short enough to bound an
// abandoned flow"). That was a confirmed timed-bypass defect, not a
// merely-generous choice: the recovery-derived Supabase session itself
// is NOT bounded by this cookie at all -- it is a wholly separate
// cookie, set by @supabase/ssr, with its own independent maxAge. Traced
// directly (not assumed) to node_modules/@supabase/ssr/dist/module/
// utils/constants.js:
//   export const DEFAULT_COOKIE_OPTIONS = { path: "/", sameSite: "lax",
//     httpOnly: false, maxAge: 400 * 24 * 60 * 60 };
// -- 400 days, the maximum any modern browser honors at all (the
// source file's own comment cites
// https://developer.chrome.com/blog/cookie-max-age-expires, Chrome's
// own hard cap, not an arbitrary Supabase choice). Confirmed this
// governs Librum's ACTUAL session cookie: neither
// src/lib/supabase/server.ts nor src/lib/supabase/middleware.ts passes
// a `cookieOptions` override to createServerClient(), so this default
// applies unmodified. Proxy (src/proxy.ts) refreshes that session on
// every single request via supabase.auth.getUser() -- as long as the
// refresh token stays valid (Supabase's own default: no fixed expiry,
// good until revoked or superseded), the underlying session can
// realistically stay alive far longer than any short, independent
// recovery-cookie TTL.
//
// The exploit this produced: 15 minutes after a recovery link was
// clicked, `librum-recovery` disappears from the browser (its own
// maxAge elapsed) while the Supabase session cookie -- governed by the
// UNRELATED, much longer maxAge above -- is still fully valid and still
// silently refreshing. From that moment, isRecoverySessionActive()
// reads false, Proxy stops redirecting, and the recovery-derived
// session becomes ordinary, unrestricted, authenticated access without
// the user ever having set a new password. Confirmed via
// src/lib/recovery-session.test.ts's own
// "recovery session survives longer than the original 15-minute
// marker" test, which fails under the old value and passes under this
// one.
//
// The required invariant (LAUNCH-1 P1-11 correction) is that this
// marker must NEVER independently outlive the session it restricts --
// it may end ONLY via a confirmed successful password update, an
// explicit logout, or the underlying session itself becoming invalid,
// never merely because its own clock ran out first. A cookie-based
// marker cannot make that guarantee unconditionally for all time (any
// TTL is, definitionally, a TTL) -- but it CAN make the practical
// bypass window as large as a browser cookie is physically capable of
// being, which is exactly what setting this to the SAME 400-day figure
// governing the real session cookie achieves: neither cookie can
// outlive the other by design, since both are already pinned to the
// same browser-enforced ceiling. Deliberately not "a bit longer than
// 15 minutes" or any other guessed number -- this is the literal
// constant the installed @supabase/ssr version itself uses, cited
// directly, so the two lifetimes are provably matched rather than
// independently estimated.
export const RECOVERY_COOKIE_TTL_SECONDS = 400 * 24 * 60 * 60;

// The only value ever written -- presence, not content, is the signal.
const RECOVERY_COOKIE_VALUE = "1";

// ---------------------------------------------------------------------
// Pure decision logic -- directly unit-testable with a plain object,
// the same extraction technique already used for decideAdminAccess()
// (src/lib/auth.ts) and shouldExposeStripeCheckoutSession()
// (src/app/bundles/[id]/link-back.ts). Every impure wrapper below
// (proxy, Server Actions, Route Handlers) delegates to these two
// functions rather than re-implementing the check.
// ---------------------------------------------------------------------

// Structural, not the real cookie-store type -- satisfied by both
// Next.js's `next/headers` cookies() store (Server Components/Actions/
// Route Handlers) and a NextRequest's `.cookies` (Proxy), so this one
// predicate works identically in every runtime context without either
// depending on a concrete Next.js type or duplicating the read.
export type RecoveryCookieReader = {
  get(name: string): { value: string } | undefined;
};

export function isRecoverySessionActive(cookies: RecoveryCookieReader): boolean {
  return cookies.get(RECOVERY_COOKIE_NAME)?.value === RECOVERY_COOKIE_VALUE;
}

// Everything reachable while recovery is active -- deliberately just
// three page paths, not a path-prefix/regex scheme: /reset-password (to
// complete recovery), /auth/callback (a second recovery link, or a
// redelivered one, must still work -- see the audit's "two tabs"/
// "replayed link" edge cases), and /login (where updatePassword()
// itself redirects to on success, and the only other page the
// site-wide header could legitimately still be rendering for a
// recovery-restricted session -- see the audit's own reasoning for why
// no separate "logout action path" entry is needed: the header's
// logout form always posts to whatever page it's currently rendered
// on, and by construction that can only ever be one of these three,
// since every other page redirects here before it ever renders).
// Exact string match, not startsWith -- deliberately does NOT cover
// /reset-password's own query-string variants beyond the path itself,
// since Next.js path matching for this purpose is on pathname only.
const RECOVERY_ALLOWED_PATHS = new Set(["/reset-password", "/auth/callback", "/login"]);

// The actual redirect decision Proxy enforces -- pure function of the
// two facts that matter (is recovery active, what path was requested),
// with no Next.js/cookie dependency at all, so Proxy's own containment
// logic (src/lib/supabase/middleware.ts) can be fully covered by tests
// that never need to construct a real NextRequest/NextResponse pair.
export function shouldRedirectForRecovery(pathname: string, recoveryActive: boolean): boolean {
  return recoveryActive && !RECOVERY_ALLOWED_PATHS.has(pathname);
}

// ---------------------------------------------------------------------
// Impure wrappers -- one shared cookie-options builder, then thin
// read/write helpers for each of the three Next.js runtime shapes that
// need to touch this cookie. No call site outside this file constructs
// these options or the cookie name/value directly.
// ---------------------------------------------------------------------

function recoveryCookieOptions() {
  return {
    httpOnly: true,
    // Secure in production only -- matches this codebase's own existing
    // production-vs-not posture (see src/lib/site-url.ts, LAUNCH-1
    // P1-10) rather than inventing a second convention; local
    // http://localhost dev traffic has no TLS to require.
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: RECOVERY_COOKIE_TTL_SECONDS,
  };
}

// Structural writer type -- satisfied by both `next/headers`'s mutable
// cookies() store (Server Actions/Route Handlers) and NextResponse's
// `.cookies` (Proxy).
export type RecoveryCookieWriter = {
  set(name: string, value: string, options?: Record<string, unknown>): void;
  delete(name: string): void;
};

// Two callers, both trusting this function entirely -- neither is where
// the "should recovery actually be active" decision is made:
//   1. src/app/auth/callback/route.ts -- the ORIGINATING set, only once
//      the exchange's own redirectType has been confirmed to be
//      "recovery" (see isRecoveryExchange() there).
//   2. src/lib/supabase/middleware.ts -- LAUNCH-1 P1-11 SLIDING-LIFETIME
//      CORRECTION: re-set on every request while
//      isRecoverySessionActive() already reads true, so the marker's
//      own maxAge renews in lockstep with however long the underlying
//      Supabase session cookie's OWN sliding window turns out to run
//      (see that file's own comment for the full trace of why a
//      one-time, never-renewed maxAge would eventually drift shorter
//      than the session it's meant to restrict).
export function setRecoverySession(cookies: RecoveryCookieWriter): void {
  cookies.set(RECOVERY_COOKIE_NAME, RECOVERY_COOKIE_VALUE, recoveryCookieOptions());
}

// Called from every point in the codebase where recovery is confirmed
// over, in either of two distinct senses -- LAUNCH-1 P1-11 STALE-MARKER
// CORRECTION widened this from the original two call sites to five:
//   1. updatePassword() -- only on a CONFIRMED successful
//      supabase.auth.updateUser() call (recovery genuinely completed).
//   2. logout() -- unconditional (the session itself is ending).
//   3. login() -- only on a CONFIRMED successful signInWithPassword()
//      call (a stale marker from an earlier, unrelated abandoned
//      recovery attempt must not restrict this new, unrelated session).
//   4. signup() -- only when signUp() succeeds AND data.session is
//      truthy (an ordinary session was just established immediately;
//      same stale-marker reasoning as login()).
//   5. src/app/auth/callback/route.ts's GET handler -- only on a
//      confirmed successful exchange that is NOT a recovery exchange
//      (isRecoveryExchange() false) -- e.g. an email-confirmation link.
// Never called from anywhere else. delete() alone (no options) is
// sufficient here: Next's cookie store matches by name for deletion, it
// doesn't need the original write-time options replayed.
export function clearRecoverySession(cookies: RecoveryCookieWriter): void {
  cookies.delete(RECOVERY_COOKIE_NAME);
}
