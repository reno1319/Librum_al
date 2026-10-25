import "server-only";
import { AUTHOR_AGE_FIELD } from "@/lib/author-age-statement";

// AUTHOR-AGE-1 (pipeline item 7, Renato 10-24 "4. a"): the Terms say an
// author must be 18 or older. Becoming an author -- at sign-up with
// "Author" chosen, or later through "Become an author" -- needs the
// "I'm 18 or older" tick, checked on the server, and the confirmation
// is recorded in the account's app_metadata: the auth data a signed-in
// user cannot change (auth.updateUser() writes user_metadata only). No
// table and no migration. Accounts that were authors before this
// change were skipped on purpose (Renato, "5. a").
//
// SECURITY-9A: the record is written together with the Terms record by
// recordAgreements() (src/lib/agreement-records.ts).

export function hasAuthorAgeTick(formData: FormData): boolean {
  // An unticked checkbox is absent from FormData; "on" is the browser's
  // value for a ticked box without a value attribute.
  return formData.get(AUTHOR_AGE_FIELD) === "on";
}
