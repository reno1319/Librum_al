import "server-only";
import type { User } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAgreements } from "@/lib/agreement-records";
import { switchNewAccountToAuthor } from "@/lib/author-signup-switch";
import { ACCOUNT_NAME_MAX_LENGTH } from "@/lib/account-name";
import type { AccountKind } from "@/lib/types";

// K7 Google sign-in (Renato 11-16): "Vazhdo me Google" on /login and
// /signup, with one line under it (Terms + Privacy), no extra page.
//
// The sign-up page's Google button uses the choices already on that
// page: "Autor" + the 18+ tick make an author (Renato "b"). The Server
// Action checks the tick, then leaves this short-lived cookie for the
// callback. The cookie is only a hint carried across Google's screen:
// it can only ADD the author switch to a brand-new Google account, the
// same thing ticking the 18+ box on the page does.
export const GOOGLE_AUTHOR_INTENT_COOKIE = "librum_google_author";
export const GOOGLE_AUTHOR_INTENT_MAX_AGE_SECONDS = 600;
// BUILD 2a-1: the same cookie with this value carries "Shtëpi botuese"
// (no 18+ tick, h2 b); "1" stays "Autor". Like "1", it can only add the
// switch to a brand-new Google account.
export const GOOGLE_HOUSE_INTENT_VALUE = "house";

// The callback's marker that the exchange started from our Google
// button. Set by signInWithGoogle() in redirectTo.
export const GOOGLE_CALLBACK_PARAM = "google";

// The same words signup() shows an author sign-up that ended as a reader
// (already allowed on /account by src/lib/page-messages.ts).
export const GOOGLE_AUTHOR_PENDING_MESSAGE =
  "Llogaria juaj u krijua si llogari lexuesi. Për të botuar, përdorni \"Botoni librat tuaj\" në këtë faqe.";

export type GoogleFinish = "reader" | "author" | "author_failed";

function hasIdentity(user: User, provider: string): boolean {
  return (user.identities ?? []).some((identity) => identity.provider === provider);
}

// The name Google gives (full_name, else name), trimmed and cut to the
// account-name limit; null when there is none.
export function googleDisplayName(user: User): string | null {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  for (const key of ["full_name", "name"]) {
    const value = meta[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim().slice(0, ACCOUNT_NAME_MAX_LENGTH).trim();
    }
  }
  return null;
}

// After a successful Google exchange. Only a FIRST Google sign-in of an
// account with no Terms record, and no email/password identity, is
// treated as a new Google sign-up:
//   1. its Terms record is written, marked "google_notice";
//   2. its name becomes the Google name (handle_new_user() otherwise
//      leaves the part of the address before "@");
//   3. with the author hint, the 18+ record is written too and the
//      account is switched to author, the Google name being its public
//      author name (the same switch as the sign-up form). With the
//      house hint (kind 'publishing_house', BUILD 2a-1) it is switched
//      to an author account of the house kind, with no 18+ record.
// Any other account (it signed up with the form, or already signed in
// with Google before) is left exactly as it is. A failure is logged
// without the id or address, and sign-in goes on, like signup().
export async function finishGoogleSignIn(
  user: User,
  wantsAuthor: boolean,
  kind: AccountKind = "person",
): Promise<GoogleFinish> {
  const appMeta = (user.app_metadata ?? {}) as Record<string, unknown>;
  const isNewGoogleAccount =
    hasIdentity(user, "google") && !hasIdentity(user, "email") && !appMeta.terms_accepted_at;
  if (!isNewGoogleAccount) return "reader";

  const name = googleDisplayName(user);
  if (name) {
    const { error } = await createAdminClient().from("profiles").update({ display_name: name }).eq("id", user.id);
    if (error) console.error("google sign-in: name not saved", { code: error.code ?? null });
  }

  const house = wantsAuthor && kind === "publishing_house";
  const recorded = await recordAgreements(user.id, { authorAge: wantsAuthor && !house, viaGoogleNotice: true });
  if (!wantsAuthor) return "reader";
  if (!recorded || !name) return "author_failed";
  return (await switchNewAccountToAuthor(user.id, name, house ? "publishing_house" : "person"))
    ? "author"
    : "author_failed";
}
