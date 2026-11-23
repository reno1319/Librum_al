import "server-only";
import { createAuthorRoleWriteClient } from "@/lib/author-role-write-client";

// K7: moved here from auth/actions.ts unchanged, so the Google sign-in
// finish (src/lib/google-sign-in.ts) uses the same switch. Not a Server
// Action: a "use server" file would expose it to the browser.
// SECURITY-9A: the database makes every new account a reader, so an
// author sign-up is switched here, with the author-role writer (the
// rules in src/lib/author-role-write-client.ts): only reader -> author,
// only the row of the account signUp() just created, only role and
// public_author_name = the trimmed sign-up name (the row
// handle_new_user() used to write for an author; the database then
// gives the default pen name). Exactly one changed row, now an author,
// or it fails closed. Logged without the id.
export async function switchNewAccountToAuthor(userId: string, publicAuthorName: string): Promise<boolean> {
  const { data: rows, error } = await createAuthorRoleWriteClient()
    .from("profiles")
    .update({ role: "author", public_author_name: publicAuthorName })
    .eq("id", userId)
    .eq("role", "reader")
    .select("id, role");
  if (
    error ||
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    rows[0]?.id !== userId ||
    rows[0]?.role !== "author"
  ) {
    console.error("signup: the switch to author failed", {
      code: error?.code ?? null,
      rowCount: Array.isArray(rows) ? rows.length : null,
    });
    return false;
  }
  return true;
}
