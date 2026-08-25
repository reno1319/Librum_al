import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import {
  isRecoverySessionActive,
  shouldRedirectForRecovery,
  setRecoverySession,
} from "@/lib/recovery-session";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

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
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // Refreshes the auth token if it's expired. Required for server components
  // to see a valid session, since they can't write cookies themselves.
  await supabase.auth.getUser();

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
