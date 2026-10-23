import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  isRecoverySessionActive,
  shouldRedirectForRecovery,
  setRecoverySession,
} from "@/lib/recovery-session";
import { INTERNAL_PATHNAME_HEADER } from "@/lib/internal-headers";
import { assertSupabaseEnvSafeForExecution } from "@/lib/supabase/env-guard";
import {
  SUSPENDED_LOGIN_PATH,
  SUSPENDED_MESSAGE,
  SUSPENSION_CHECK_FAILED_MESSAGE,
  decideSuspension,
  isUserBannedError,
  wantsStatusInsteadOfRedirect,
} from "@/lib/suspension-gate";

// LIBRUM 2.0 AUTH-2: the only reliable way for a Server Component/Layout
// to learn the current request's pathname in this Next.js version --
// there is no server-side equivalent of the client-only usePathname()
// hook. Proxy already sees `request.nextUrl.pathname` on effectively
// every request (the shared matcher in src/proxy.ts), so it's forwarded
// here as a request header dashboard/layout.tsx reads via headers().
// Deliberately request-header (forwarded upstream to the render), never
// a response header (which would only reach the browser, not the
// server-rendered layout) -- see NextResponse.next({ request: { headers } })
// below, the documented mechanism for this exact purpose
// (node_modules/next/dist/docs/.../proxy.md "Setting Headers").
//
// Spoofing: deleted unconditionally before being set from
// request.nextUrl.pathname, so any incoming client-supplied value of
// this same header name is always discarded first -- the forwarded
// value is only ever this request's own real, Next.js-parsed pathname,
// never attacker input. No query string is included (see the AUTH-2
// audit's query-string decision) and no secrets are ever placed on it.
// PEOPLE-2: the response that ends a suspended session -- a redirect to
// /login?suspended=1 for a page, a plain 403 for a Server Action or
// /api (they can't follow a page redirect). Carries any cookie the
// client already set (signOut's removal) and expires every Supabase
// auth cookie the request carried, so the session is gone from this
// browser whatever signOut did.
function cutOffSuspendedSession(request: NextRequest, supabaseResponse: NextResponse): NextResponse {
  const cutOff = wantsStatusInsteadOfRedirect(request)
    ? new NextResponse(SUSPENDED_MESSAGE, {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      })
    : NextResponse.redirect(new URL(SUSPENDED_LOGIN_PATH, request.url));
  supabaseResponse.cookies.getAll().forEach((cookie) => cutOff.cookies.set(cookie));
  request.cookies
    .getAll()
    .filter((cookie) => cookie.name.startsWith("sb-"))
    .forEach((cookie) => cutOff.cookies.set(cookie.name, "", { path: "/", maxAge: 0 }));
  return cutOff;
}

export async function updateSession(request: NextRequest) {
  // AUTH-STAGE-1A: see env-guard.ts. Proxy defaults to the Node.js
  // runtime in this Next.js version (not Edge -- confirmed against
  // node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
  // proxy.md's own "Runtime" section), so process.env.VERCEL_ENV is
  // genuinely available here on effectively every request, unlike in
  // client.ts's browser-bundled code.
  assertSupabaseEnvSafeForExecution();

  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(INTERNAL_PATHNAME_HEADER);
  requestHeaders.set(INTERNAL_PATHNAME_HEADER, request.nextUrl.pathname);

  let supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          supabaseResponse = NextResponse.next({ request: { headers: requestHeaders } });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the auth token if it's expired. Required for server components
  // to see a valid session, since they can't write cookies themselves.
  const {
    data: { user },
    error: userError,
  } = await supabase.auth.getUser();

  // PEOPLE-2 audit F1: current Supabase Auth refuses a banned user's
  // access token with 403 user_banned, so getUser() returns no user and
  // the normal path below never sees them. That refusal IS the
  // suspension signal: end the session here. No signOut() -- its
  // /logout call is refused the same way, so it revokes nothing. The
  // account's refresh tokens are refused while banned; a device that
  // never makes a request during the suspension keeps its cookie and
  // its session resumes after Lift (accepted, PEOPLE-2 r2 report).
  if (!user && isUserBannedError(userError)) {
    return cutOffSuspendedSession(request, supabaseResponse);
  }

  // PEOPLE-2: a suspended account is cut off on its next request, not
  // when its access token happens to expire. Signed-in requests only;
  // see src/lib/suspension-gate.ts for the decision and why an RPC
  // failure fails closed. If getUser() failed for any other reason,
  // user is null and nothing changes: every page and action calls
  // getUser() again and treats the caller as signed out.
  if (user) {
    let rpc: { data: unknown; error: unknown };
    try {
      rpc = await supabase.rpc("my_account_is_suspended");
    } catch (rpcError) {
      rpc = { data: null, error: rpcError };
    }
    const decision = decideSuspension({ bannedUntil: user.banned_until, rpc });

    if (decision === "check_failed") {
      console.error("updateSession: the suspension check failed for a signed-in request", {
        code: (rpc.error as { code?: string } | null)?.code ?? null,
      });
      const failed = new NextResponse(SUSPENSION_CHECK_FAILED_MESSAGE, {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
      supabaseResponse.cookies.getAll().forEach((cookie) => failed.cookies.set(cookie));
      return failed;
    }

    if (decision === "suspended") {
      // Reached when the account is suspended but its token is still
      // accepted (the ban step failed, or an older Supabase Auth).
      // Global scope: revokes every refresh token of the account, then
      // clears this browser's session cookies through the same setAll
      // above. auth-js 2.112 removes the local session even when the
      // revoke call errors (GoTrueClient _signOut), and the cookies are
      // also expired by hand in cutOffSuspendedSession. An
      // access token already issued keeps working against the Data API
      // until it expires (up to 1 hour, within RLS); publishing and
      // deleting stay blocked by the LB464/LB465 triggers
      // (BRIEF-PEOPLE-r4 residual).
      try {
        await supabase.auth.signOut({ scope: "global" });
      } catch (signOutError) {
        console.error("updateSession: signOut threw while cutting off a suspended session", { error: signOutError });
      }
      return cutOffSuspendedSession(request, supabaseResponse);
    }
  }

  // LAUNCH-1 P1-11: centralized password-recovery-session containment --
  // see the P1-11 audit for the full rationale. This runs on
  // (effectively) every request Proxy sees, before any page, Server
  // Action, or Route Handler executes, so it is the primary boundary
  // for the security property, not merely a UI convenience -- Next.js's
  // own docs (node_modules/next/dist/docs/.../proxy.md) confirm a
  // Server Function's POST targets "the route where it's used," so this
  // same pathname check also catches a crafted direct POST to a
  // protected Server Action, not only page navigation. Deliberately
  // still paired with defense-in-depth at the highest-value Server
  // Actions/Route Handlers themselves (buyBook, buyBundle, the download
  // route, admin refund issuance) per that same doc's own explicit
  // recommendation not to rely on Proxy alone.
  //
  // The redirect decision itself (shouldRedirectForRecovery) is a pure
  // function, fully covered by its own unit tests
  // (src/lib/recovery-session.test.ts) -- this function's only job is
  // the Next.js-specific plumbing: reading the cookie from the request,
  // and -- critically -- copying every cookie the refresh above just
  // set onto the redirect response, so a token refresh that happened
  // during THIS request is never silently discarded by choosing to
  // redirect instead of returning supabaseResponse.
  const recoveryActive = isRecoverySessionActive(request.cookies);

  // LAUNCH-1 P1-11 SLIDING-LIFETIME CORRECTION: even with the recovery
  // marker's own maxAge matching @supabase/ssr's 400-day default (see
  // RECOVERY_COOKIE_TTL_SECONDS), the two cookies can still drift apart
  // over time. Traced directly (not assumed) in
  // node_modules/@supabase/ssr/dist/module/cookies.js's
  // applyServerStorage(): every time it writes cookies (createServerClient.js's
  // own onAuthStateChange listener triggers this on SIGNED_IN,
  // TOKEN_REFRESHED, USER_UPDATED, and other auth events) it sets
  // `maxAge: DEFAULT_COOKIE_OPTIONS.maxAge` FRESH, counted from that
  // moment -- a true sliding window. A session refreshed at day 300
  // (ordinary, since access tokens typically refresh roughly hourly)
  // gets a cookie now valid until ~day 700, while our recovery marker,
  // set once at day 0 and never touched again, would still expire at
  // day 400 -- reopening the exact timed-bypass window this whole
  // correction exists to close, merely delayed rather than prevented.
  //
  // The fix: renew the recovery marker's own maxAge on EVERY request
  // while recovery is active, unconditionally -- not only when this
  // particular request happened to trigger a Supabase token refresh.
  // This is simpler and strictly stronger than trying to detect "did
  // Supabase just refresh its cookies THIS request" (which would
  // require reaching into the setAll callback's own invocation state);
  // renewing unconditionally guarantees the marker's expiry is always
  // >= now + RECOVERY_COOKIE_TTL_SECONDS as long as the browser makes
  // ANY request at all, which trivially dominates whatever cadence
  // Supabase's own sliding window follows, since Supabase can only ever
  // refresh in response to a request passing through this same
  // function. Stops the moment recovery is genuinely over: once
  // updatePassword()/logout() (src/app/auth/actions.ts) clear the
  // cookie, the very next request sees recoveryActive === false here
  // and renewal naturally stops -- no separate "don't renew after
  // clearing" logic is needed, since a cleared cookie is, from this
  // function's perspective, simply absent.
  if (recoveryActive) {
    setRecoverySession(supabaseResponse.cookies);
  }

  if (shouldRedirectForRecovery(request.nextUrl.pathname, recoveryActive)) {
    const redirectResponse = NextResponse.redirect(new URL("/reset-password", request.url));
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie);
    });
    return redirectResponse;
  }

  return supabaseResponse;
}
