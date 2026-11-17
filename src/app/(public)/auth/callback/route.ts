import { scheduleAuthorWelcome } from "@/lib/author-welcome";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { setRecoverySession, clearRecoverySession } from "@/lib/recovery-session";
import { resolveSafeInternalPath } from "@/lib/safe-redirect";
import {
  CONFIRMATION_LINK_INVALID_MESSAGE,
  GOOGLE_SIGN_IN_FAILED_MESSAGE,
  RECOVERY_LINK_INVALID_MESSAGE,
} from "@/lib/auth-page-messages";
import {
  GOOGLE_AUTHOR_INTENT_COOKIE,
  GOOGLE_AUTHOR_PENDING_MESSAGE,
  GOOGLE_CALLBACK_PARAM,
  finishGoogleSignIn,
} from "@/lib/google-sign-in";

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

// AUTH-1E: the only two purposes this route's token_hash path accepts.
// Deliberately narrower than the SDK's own EmailOtpType (which also
// covers "invite"/"magiclink"/"email"/"email_change"/an open string
// fallback) -- `type` doubles here as the signal that decides whether
// to set the recovery-session restriction below, so it must be a
// closed, Librum-controlled set rather than whatever a query string
// happens to carry. If Librum's configured email templates ever use a
// different type (e.g. "email"), this route must be updated alongside
// them, not silently widened to accept it.
type TokenHashType = "signup" | "recovery";

function parseTokenHashType(value: string | null): TokenHashType | null {
  return value === "signup" || value === "recovery" ? value : null;
}

// AUTH-1E: which failure copy to show. `type === "recovery"` covers a
// rejected/unsupported type on the token_hash path; `next ===
// "/reset-password"` is requestPasswordReset()'s own fixed redirectTo
// value (see auth/actions.ts) and is the only recovery signal available
// after a failed code exchange, which has no other data to inspect.
export function isRecoveryAttempt(type: string | null, next: string): boolean {
  return type === "recovery" || next === "/reset-password";
}

// AUTH-1E: one safe, non-leaking failure destination -- never the raw
// Supabase/GoTrue error, only a choice between signup and recovery copy.
function buildFailureRedirect(origin: string, type: string | null, next: string): string {
  const message = isRecoveryAttempt(type, next)
    ? RECOVERY_LINK_INVALID_MESSAGE
    : CONFIRMATION_LINK_INVALID_MESSAGE;
  return `${origin}/login?error=${encodeURIComponent(message)}`;
}

// Handles the link Supabase emails out for signup/password-reset
// confirmation. Supports two query-param shapes:
//   - `?code=...` -- PKCE authorization code, exchanged via
//     exchangeCodeForSession().
//   - `?token_hash=...&type=signup|recovery` -- verified directly via
//     verifyOtp(), for links that arrive without a stored PKCE
//     verifier (e.g. opened in a different browser/device than the one
//     that started the request).
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  // LAUNCH-1 P1: routed through the same centralized safe-redirect policy
  // login() uses (src/lib/safe-redirect.ts) rather than trusting the raw
  // query param. Building the final Location by concatenating `origin`
  // (this route's own trusted, request-derived value -- never
  // user-controlled) with a URL-parser-validated internal path is what
  // actually closes this off, not the previous `${origin}${next}`
  // concatenation's accidental (and fragile) safety.
  const next = resolveSafeInternalPath(searchParams.get("next")) ?? "/";

  // K7: an exchange started by "Vazhdo me Google" (signInWithGoogle()
  // puts google=1 in redirectTo). Its own failure message, and the
  // author hint cookie is always removed.
  if (searchParams.get(GOOGLE_CALLBACK_PARAM) === "1") {
    return googleCallback(request, origin, code, next);
  }

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
        // AUTHOR-EMAILS: an author's first confirmed sign-in gets the
        // welcome email once (the claim inside makes later ones no-ops).
        if (data.user) scheduleAuthorWelcome(data.user.id);
      }
      return response;
    }
    return NextResponse.redirect(buildFailureRedirect(origin, type, next));
  }

  // AUTH-1E: token_hash path -- only for an exact, supported `type`.
  // An unsupported or missing type is rejected here, before verifyOtp()
  // is called and before a Supabase client is even created.
  if (tokenHash) {
    const verifiedType = parseTokenHashType(type);
    if (verifiedType) {
      const supabase = await createClient();
      const { data, error } = await supabase.auth.verifyOtp({ type: verifiedType, token_hash: tokenHash });
      if (!error) {
        const response = NextResponse.redirect(`${origin}${next}`);
        if (verifiedType === "recovery") {
          setRecoverySession(response.cookies);
        } else {
          clearRecoverySession(response.cookies);
          // AUTHOR-EMAILS: the sign-up confirmation link (Production's
          // template uses this token_hash path).
          if (data?.user) scheduleAuthorWelcome(data.user.id);
        }
        return response;
      }
      return NextResponse.redirect(buildFailureRedirect(origin, type, next));
    }
  }

  return NextResponse.redirect(buildFailureRedirect(origin, type, next));
}

// K7: true when the request carries the author hint cookie set by
// signInWithGoogle() (the sign-up page, "Autor" + 18+ ticked).
function hasGoogleAuthorIntent(request: Request): boolean {
  const header = request.headers.get("cookie") ?? "";
  return header.split(";").some((part) => {
    const [name, value] = part.trim().split("=");
    return name === GOOGLE_AUTHOR_INTENT_COOKIE && value === "1";
  });
}

async function googleCallback(request: Request, origin: string, code: string | null, next: string) {
  const wantsAuthor = hasGoogleAuthorIntent(request);
  let response: NextResponse;
  const supabase = code ? await createClient() : null;
  const exchange = supabase && code ? await supabase.auth.exchangeCodeForSession(code) : null;
  const user = exchange && !exchange.error ? exchange.data.user : null;
  if (!user) {
    response = NextResponse.redirect(
      `${origin}/login?error=${encodeURIComponent(GOOGLE_SIGN_IN_FAILED_MESSAGE)}`,
    );
  } else if (isRecoveryExchange(exchange?.data)) {
    // K7 audit B1: a password-reset code with google=1 added must keep
    // the recovery containment (LAUNCH-1 P1-11): mark the session and go
    // to /reset-password, exactly as the ordinary path would. Nothing is
    // finished for it.
    response = NextResponse.redirect(`${origin}/reset-password`);
    setRecoverySession(response.cookies);
  } else {
    const finish = await finishGoogleSignIn(user, wantsAuthor);
    const target =
      finish === "author"
        ? "/dashboard"
        : finish === "author_failed"
          ? `/account?error=${encodeURIComponent(GOOGLE_AUTHOR_PENDING_MESSAGE)}`
          : next;
    response = NextResponse.redirect(`${origin}${target}`);
    // A Google sign-in is never a recovery: like any ordinary exchange,
    // it clears a stale recovery marker (LAUNCH-1 P1-11).
    clearRecoverySession(response.cookies);
    // AUTHOR-EMAILS: after finishGoogleSignIn() so a new Google author
    // is already an author when the claim runs.
    scheduleAuthorWelcome(user.id);
  }
  response.cookies.set(GOOGLE_AUTHOR_INTENT_COOKIE, "", { path: "/auth/callback", maxAge: 0 });
  return response;
}
