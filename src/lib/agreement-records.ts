import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { AUTHOR_AGE_STATEMENT_VERSION } from "@/lib/author-age-statement";

// SECURITY-9A (pipeline item 9, Renato 10-24 "3. a" and, after the r1
// audit, "2. a"): the Terms tick -- and for an author the "I'm 18 or
// older" tick (AUTHOR-AGE-1) -- are recorded on the account: at every
// sign-up through the site, and again at "Become an author", which
// always asks for both ticks. Same place as AUTHOR-AGE-1: app_metadata,
// the auth data a signed-in user cannot change. An account made by
// calling Supabase Auth directly (skipping the site) has no Terms record
// until it agrees through the site, so it can be spotted, and the record
// is proof of agreement. No author exists without both records, except
// authors from before AUTHOR-AGE-1 (skipped on purpose, Renato "5. a").
//
// Changing the Terms means a new TERMS_VERSION, so a record still says
// which Terms the person agreed to ("Last updated: October 2026").
export const TERMS_VERSION = "terms-2026-10";

// The sign-up form's and the Become-an-author form's Terms checkbox.
export const TERMS_FIELD = "accept_terms";

export function hasTermsTick(formData: FormData): boolean {
  // An unticked checkbox is absent from FormData; "on" is the browser's
  // value for a ticked box without a value attribute.
  return formData.get(TERMS_FIELD) === "on";
}

// One write through the service role, only for an account the caller
// has already proved: the user signUp() just created, or the signed-in
// caller of "Become an author" (auth.getUser()). GoTrue merges
// app_metadata keys, so provider/providers stay as they are. A failure
// is logged without the id or e-mail.
export async function recordAgreements(
  userId: string,
  { authorAge }: { authorAge: boolean },
): Promise<boolean> {
  const now = new Date().toISOString();
  const { error } = await createAdminClient().auth.admin.updateUserById(userId, {
    app_metadata: {
      terms_accepted_at: now,
      terms_version: TERMS_VERSION,
      ...(authorAge
        ? { author_age_confirmed_at: now, author_age_statement_version: AUTHOR_AGE_STATEMENT_VERSION }
        : {}),
    },
  });
  if (error) {
    console.error("recordAgreements: not recorded", { status: error.status ?? null });
    return false;
  }
  return true;
}
