import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setRecoverySession, clearRecoverySession } from "@/lib/recovery-session";
import { resolveSafeInternalPath } from "@/lib/safe-redirect";

// LAUNCH-1 P1-11: the installed @supabase/auth-js runtime attaches a
// `redirectType` field to exchangeCodeForSession()'s resolved data when
// the exchanged code came from a password-recovery link -- traced end
// to end through node_modules/@supabase/auth-js/dist/module/
// GoTrueClient.js and lib/helpers.js by the P1-11 audit:
// resetPasswordForEmail() stores the PKCE verifier as
// "<verifier>/recovery", and _exchangeCodeForSession() splits that back
// apart and attaches `redirectType: "recovery"` onto its return value.
// exchangeCodeForSession()'s PUBLIC TypeScript return type
// (AuthTokenResponse) does not declare this field -- it is currently
// undocumented SDK-internal behavior, not a stable public contract.
//
// This is the ONLY place in Librum that knows this field exists.
// Every other call site (src/proxy.ts, src/lib/supabase/middleware.ts,
// src/app/auth/actions.ts) works exclusively with the boolean this
// function returns -- none of them import or reference "redirectType"
// anywhere. Deliberately narrow and defensive: an unexpected shape (a
// future SDK version renaming/removing the field, or any value that
// doesn't look like what this SDK actually returns) is treated as "not
// a recovery exchange" -- this function's `true` result only ever ADDS
// a restriction (see the call site below), never removes one, so
// failing toward `false` on anything unexpected is the safe direction,
// not a silent trust of an arbitrary value.
//
// AUTH-1C: because this reads an undocumented internal field rather
// than a stable public API contract, it must be RE-AUDITED on every
// @supabase/ssr/@supabase/auth-js upgrade -- do not assume this still
// holds after a dependency bump. route.test.ts's "installed SDK still
// derives redirectType the way this function assumes" test reads the
// installed @supabase/auth-js source directly and fails loudly if a
// future version stops matching this contract, so an upgrade that
// silently breaks recovery detection fails CI instead of shipping.
export function isRecoveryExchange(exchangeResult: unknown): boolean {
  if (typeof exchangeResult !== "object" || exchangeResult === null) {
    return false;
  }
  const redirectType = (exchangeResult as { redirectType?: unknown }).redirectType;
  return redirectType === "recovery";
}

// Handles the link Supabase emails out for signup/password-reset
// confirmation: it exchanges the one-time code for a real session.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // LAUNCH-1 P1: routed through the same centralized safe-redirect policy
  // login() uses (src/lib/safe-redirect.ts) rather than trusting the raw
  // query param. Building the final Location by concatenating `origin`
  // (this route's own trusted, request-derived value -- never
  // user-controlled) with a URL-parser-validated internal path is what
  // actually closes this off, not the previous `${origin}${next}`
  // concatenation's accidental (and fragile) safety.
  const next = resolveSafeInternalPath(searchParams.get("next")) ?? "/";

  if (code) {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const response = NextResponse.redirect(`${origin}${next}`);
      // LAUNCH-1 P1-11: only a genuine password-recovery exchange marks
      // the resulting session as recovery-restricted -- an ordinary
      // signup-confirmation or OAuth exchange never does, since
      // isRecoveryExchange() only returns true for the exact
      // redirectType Supabase's own recovery flow produces. Neither
      // branch below is ever reached when `error` is truthy -- a
      // failed/unknown exchange touches the recovery marker not at all,
      // leaving any existing active recovery state exactly as it was.
      //
      // LAUNCH-1 P1-11 STALE-MARKER CORRECTION: this route is also used
      // for ordinary, non-recovery confirmations (its own doc comment
      // above: "signup/password-reset confirmation") -- a CONFIRMED
      // successful exchange that is NOT a recovery exchange establishes
      // an ordinary authenticated session, so any stale recovery marker
      // left over from an earlier abandoned recovery attempt in this
      // same browser must be cleared here too, for the same reason
      // login() clears it on a successful password sign-in.
      if (isRecoveryExchange(data)) {
        setRecoverySession(response.cookies);
      } else {
        clearRecoverySession(response.cookies);
      }
      return response;
    }
  }

  return NextResponse.redirect(`${origin}/login?error=Could+not+confirm+your+email`);
}
