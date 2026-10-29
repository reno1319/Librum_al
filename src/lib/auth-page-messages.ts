// SQ-16: every message Librum itself sends to the sign-in pages
// (/login, /signup, /forgot-password, /reset-password) through
// `?error=` or `?success=`. The pages show only these, or a translated
// Supabase message (auth-error.ts); any other text in the address gets
// AUTH_GENERIC_ERROR, so a crafted link cannot put its own words on a
// Librum sign-in page.
import { ACCOUNT_NAME_TOO_LONG_MESSAGE } from "@/lib/account-name";
import { AUTHOR_AGE_REQUIRED_MESSAGE } from "@/lib/author-age-statement";

export const AUTH_FILL_ALL_FIELDS_MESSAGE = "Plotësoni të gjitha fushat.";
export const AUTH_NAME_EMPTY_MESSAGE = "Emri nuk mund të jetë bosh.";
export const AUTH_TERMS_REQUIRED_MESSAGE =
  "Duhet të pranoni Kushtet e përdorimit para se të krijoni llogarinë.";
export const AUTH_LOGIN_FAILED_MESSAGE = "Hyrja nuk u krye. Provoni përsëri.";
export const AUTH_ENTER_EMAIL_MESSAGE = "Shkruani emailin.";
export const AUTH_RESET_SEND_FAILED_MESSAGE =
  "Nuk mundëm ta dërgojmë emailin e rivendosjes tani. Prisni pak dhe provoni përsëri.";
export const AUTH_RESET_LINK_EXPIRED_MESSAGE =
  "Kjo lidhje për rivendosjen ka skaduar. Kërkoni një të re nga faqja e hyrjes.";
export const AUTH_PASSWORD_TOO_SHORT_MESSAGE = "Fjalëkalimi duhet të ketë të paktën 6 karaktere.";
export const AUTH_PASSWORDS_DIFFER_MESSAGE = "Fjalëkalimet nuk përputhen.";
export const CONFIRMATION_LINK_INVALID_MESSAGE =
  "Kjo lidhje konfirmimi nuk vlen ose ka skaduar. Kërkoni një të re.";
export const RECOVERY_LINK_INVALID_MESSAGE =
  "Kjo lidhje për rivendosjen e fjalëkalimit nuk vlen ose ka skaduar. Kërkoni një të re.";

export const AUTH_PASSWORD_CHANGED_MESSAGE = "Fjalëkalimi u ndryshua. Hyni me fjalëkalimin e ri.";

// Shown for anything in `?error=` that is neither ours nor a known
// Supabase message.
export const AUTH_GENERIC_ERROR_MESSAGE = "Diçka nuk shkoi. Provoni përsëri.";

export const OWN_AUTH_ERROR_MESSAGES: ReadonlySet<string> = new Set([
  AUTH_FILL_ALL_FIELDS_MESSAGE,
  AUTH_NAME_EMPTY_MESSAGE,
  ACCOUNT_NAME_TOO_LONG_MESSAGE,
  AUTH_TERMS_REQUIRED_MESSAGE,
  AUTHOR_AGE_REQUIRED_MESSAGE,
  AUTH_LOGIN_FAILED_MESSAGE,
  AUTH_ENTER_EMAIL_MESSAGE,
  AUTH_RESET_SEND_FAILED_MESSAGE,
  AUTH_RESET_LINK_EXPIRED_MESSAGE,
  AUTH_PASSWORD_TOO_SHORT_MESSAGE,
  AUTH_PASSWORDS_DIFFER_MESSAGE,
  CONFIRMATION_LINK_INVALID_MESSAGE,
  RECOVERY_LINK_INVALID_MESSAGE,
  AUTH_GENERIC_ERROR_MESSAGE,
]);

/** The login page's green box: only our own "password changed" line. */
export function authSuccessMessage(success: string | null | undefined): string | null {
  return success === AUTH_PASSWORD_CHANGED_MESSAGE ? AUTH_PASSWORD_CHANGED_MESSAGE : null;
}
