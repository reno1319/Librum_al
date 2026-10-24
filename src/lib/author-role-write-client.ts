import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// BECOME-AUTHOR-1: the ONE way a Server Action obtains authority to
// write public.profiles.role, which `authenticated` has never been able
// to update (migrations 033 and 046 grant only display_name, bio and
// public_author_name).
//
// There are exactly two callers, and both follow these rules, each
// pinned by src/app/(public)/account/become-author.test.ts and
// src/app/(public)/auth/actions.test.ts:
//
//   * becomeAuthor (src/app/(public)/account/become-author.ts);
//   * signup (src/app/(public)/auth/actions.ts, SECURITY-9A): the
//     database makes every new account a reader, and an author sign-up
//     is switched here. In place of rule 1, its "caller" is the account
//     signUp() itself just created and returned with an identity (no
//     session may exist yet, with email confirmation on), whose reader
//     row the database made in that same signUp; it is switched only
//     after its 18+ tick was recorded.
//
//   1. Authenticate with the session client and read the caller's own
//      profile through it BEFORE calling this. A request that is going
//      to be refused never creates privileged authority.
//   2. The only transition is reader -> author. The UPDATE is filtered
//      by `id = <the authenticated user's id>` AND `role = 'reader'`, so
//      an admin, an author or any other role can never be rewritten by
//      it. This client bypasses RLS, so those filters are the boundary.
//   3. The only columns written are role = 'author' and
//      public_author_name = the caller's own display name (the stored
//      one for becomeAuthor, the trimmed sign-up name for signup) -- the
//      row handle_new_user() gave an author sign-up before SECURITY-9A.
//      Nothing else is written.
//   4. The UPDATE returns `.select("id, role")` and must prove that
//      exactly one row changed and that it is the caller's row, now an
//      author. An error, zero rows, several rows or any mismatch fails
//      closed.
//
// `server-only` makes any import of this module from a client component
// a build error, so the key can never reach browser code through it.
export function createAuthorRoleWriteClient() {
  return createAdminClient();
}
