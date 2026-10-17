import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// BECOME-AUTHOR-1: the ONE way a Server Action obtains authority to
// write public.profiles.role, which `authenticated` has never been able
// to update (migrations 033 and 046 grant only display_name, bio and
// public_author_name).
//
// There is exactly one caller, becomeAuthor
// (src/app/(public)/account/become-author.ts), and it follows these
// rules, each pinned by src/app/(public)/account/become-author.test.ts:
//
//   1. Authenticate with the session client and read the caller's own
//      profile through it BEFORE calling this. A request that is going
//      to be refused never creates privileged authority.
//   2. The only transition is reader -> author. The UPDATE is filtered
//      by `id = <the authenticated user's id>` AND `role = 'reader'`, so
//      an admin, an author or any other role can never be rewritten by
//      it. This client bypasses RLS, so those filters are the boundary.
//   3. The only columns written are role = 'author' and
//      public_author_name = the caller's own stored display_name -- the
//      exact row handle_new_user() gives someone who signs up as an
//      author. Nothing in it comes from the client.
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
