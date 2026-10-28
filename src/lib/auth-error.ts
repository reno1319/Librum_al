// LIBRUM 2.0 UI-9: a small, additive translation for the handful of
// raw Supabase auth-provider error messages this app actually surfaces
// to a visitor today (src/app/auth/actions.ts's `error.message` is
// passed straight through as a `?error=` query param -- see login(),
// signup(), updatePassword()). This is a presentation-only concern:
// nothing here touches auth/actions.ts, validation, or redirect
// behavior -- callers apply it only when RENDERING an already-produced
// error string.
//
// Deliberately NOT a passthrough replacement of error handling: any
// message not in this list -- an unmapped Supabase message, or one of
// this app's own locally-generated strings ("Enter your email",
// "Passwords don't match", etc.) -- falls through UNCHANGED. An
// unmapped/unexpected error is still shown, never hidden or swallowed.
//
// AUTH-1C: "Email not confirmed" is mapped to the EXACT SAME string as
// "Invalid login credentials" -- not a distinct, more-informative
// message. Supabase only ever returns "Email not confirmed" from
// signInWithPassword() once it has already confirmed the email/password
// combination is correct, so surfacing it unchanged would tell a visitor
// "that account exists and this password is right, it just isn't
// confirmed yet" -- a user-enumeration + credential-validity oracle an
// ordinary wrong-password attempt never gets. Login's own generic
// "email or password isn't right" copy is truthful either way (from the
// visitor's side, both are just "you can't log in right now") and
// gives an attacker no way to distinguish the two failure modes.
const KNOWN_AUTH_ERROR_MESSAGES: Record<string, string> = {
  "Invalid login credentials": "Emaili ose fjalëkalimi nuk është i saktë. Provoni përsëri.",
  "Email not confirmed": "Emaili ose fjalëkalimi nuk është i saktë. Provoni përsëri.",
  "User already registered": "Ka tashmë një llogari me këtë email. Provoni të hyni.",
  "Password should be at least 6 characters": "Fjalëkalimi duhet të ketë të paktën 6 karaktere.",
  // PEOPLE-2: Supabase checks a ban before the password, so its ban
  // message must read exactly like a wrong password (no enumeration).
  "User is banned": "Emaili ose fjalëkalimi nuk është i saktë. Provoni përsëri.",
};

export function translateAuthErrorMessage(message: string | null | undefined): string | null {
  if (!message) {
    return null;
  }
  return KNOWN_AUTH_ERROR_MESSAGES[message] ?? message;
}
