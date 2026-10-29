// LIBRUM 2.0 UI-9: a small, additive translation for the handful of
// raw Supabase auth-provider error messages this app actually surfaces
// to a visitor today (src/app/auth/actions.ts's `error.message` is
// passed straight through as a `?error=` query param -- see login(),
// signup(), updatePassword()). This is a presentation-only concern:
// nothing here touches auth/actions.ts, validation, or redirect
// behavior -- callers apply it only when RENDERING an already-produced
// error string.
//
// SQ-16 (Renato 10-29, "2. a"): the pages no longer show raw text from
// the address. A message is shown only when it is a known Supabase
// message (translated here) or one of Librum's own messages
// (auth-page-messages.ts); anything else becomes the generic Albanian
// error, so a crafted `?error=` link cannot put its own words on a
// Librum sign-in page. Supabase matching ignores letter case and a
// trailing full stop (GoTrue versions differ on both), and a message
// GoTrue joins from several sentences is translated sentence by
// sentence.
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
import {
  AUTH_GENERIC_ERROR_MESSAGE,
  OWN_AUTH_ERROR_MESSAGES,
} from "@/lib/auth-page-messages";

const INVALID_CREDENTIALS_SQ = "Emaili ose fjalëkalimi nuk është i saktë. Provoni përsëri.";
const ALREADY_REGISTERED_SQ = "Ka tashmë një llogari me këtë email. Provoni të hyni.";
const INVALID_EMAIL_SQ = "Ky email nuk është i vlefshëm. Kontrolloni dhe provoni përsëri.";

// Keys are lowercase, without a trailing full stop.
const KNOWN_AUTH_ERROR_MESSAGES: ReadonlyMap<string, string> = new Map([
  ["invalid login credentials", INVALID_CREDENTIALS_SQ],
  ["email not confirmed", INVALID_CREDENTIALS_SQ],
  // PEOPLE-2: Supabase checks a ban before the password, so its ban
  // message must read exactly like a wrong password (no enumeration).
  ["user is banned", INVALID_CREDENTIALS_SQ],
  ["user already registered", ALREADY_REGISTERED_SQ],
  ["a user with this email address has already been registered", ALREADY_REGISTERED_SQ],
  ["email rate limit exceeded", "Janë dërguar shumë emaile për momentin. Prisni pak dhe provoni përsëri."],
  ["request rate limit reached", "Shumë përpjekje në pak kohë. Prisni pak dhe provoni përsëri."],
  ["new password should be different from the old password", "Fjalëkalimi i ri duhet të jetë ndryshe nga ai i vjetri."],
  [
    "password is known to be weak and easy to guess, please choose a different one",
    "Ky fjalëkalim është i dobët dhe i lehtë për t'u gjetur. Zgjidhni një tjetër.",
  ],
  ["signups not allowed for this instance", "Regjistrimet janë të mbyllura për momentin."],
  ["unable to validate email address: invalid format", INVALID_EMAIL_SQ],
  ["auth session missing!", "Seanca juaj ka mbaruar. Kërkoni një lidhje të re dhe provoni përsëri."],
]);

// Messages that carry a number or the typed address (matched on the
// lowercase sentence). The address is never echoed back.
const PATTERN_AUTH_ERROR_MESSAGES: ReadonlyArray<readonly [RegExp, (match: RegExpExecArray) => string]> = [
  [
    /^for security purposes, you can only request this after (\d+) seconds?$/,
    (m) => `Për arsye sigurie, mund ta provoni sërish pas ${m[1]} ${m[1] === "1" ? "sekonde" : "sekondash"}.`,
  ],
  [
    /^password should be at least (\d+) characters?$/,
    (m) => `Fjalëkalimi duhet të ketë të paktën ${m[1]} karaktere.`,
  ],
  [
    /^password should contain at least one character of each: /,
    () => "Fjalëkalimi nuk i plotëson kërkesat e sigurisë. Zgjidhni një fjalëkalim më të fortë.",
  ],
  [/^email address ".*" is invalid$/, () => INVALID_EMAIL_SQ],
];

function translateSupabaseSentence(sentence: string): string | null {
  const key = sentence.trim().toLowerCase().replace(/\.$/, "");
  const known = KNOWN_AUTH_ERROR_MESSAGES.get(key);
  if (known) return known;
  for (const [pattern, render] of PATTERN_AUTH_ERROR_MESSAGES) {
    const match = pattern.exec(key);
    if (match) return render(match);
  }
  return null;
}

function translateSupabaseMessage(message: string): string | null {
  const whole = translateSupabaseSentence(message);
  if (whole) return whole;
  // GoTrue joins several password failures with ". " ("Password should
  // be at least 8 characters. Password is known to be weak ...").
  const sentences = message.trim().split(/(?<=\.)\s+/);
  if (sentences.length < 2) return null;
  const parts: string[] = [];
  for (const sentence of sentences) {
    const part = translateSupabaseSentence(sentence);
    if (!part) return null;
    if (!parts.includes(part)) parts.push(part);
  }
  return parts.join(" ");
}

export function translateAuthErrorMessage(message: string | null | undefined): string | null {
  if (!message) {
    return null;
  }
  if (OWN_AUTH_ERROR_MESSAGES.has(message)) return message;
  return translateSupabaseMessage(message) ?? AUTH_GENERIC_ERROR_MESSAGE;
}
