import "server-only";
import { createAuthorRoleWriteClient } from "@/lib/author-role-write-client";
import type { AccountKind } from "@/lib/types";

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
// BUILD 2a-1: a "Shtëpi botuese" sign-up passes kind 'publishing_house',
// written in the same row update (account_kind) and checked in the
// answer; the sign-up name is then the house's name.
export async function switchNewAccountToAuthor(
  userId: string,
  publicAuthorName: string,
  kind: AccountKind = "person",
): Promise<boolean> {
  const house = kind === "publishing_house";
  const { data: rows, error } = await createAuthorRoleWriteClient()
    .from("profiles")
    .update(
      house
        ? { role: "author", public_author_name: publicAuthorName, account_kind: "publishing_house" }
        : { role: "author", public_author_name: publicAuthorName },
    )
    .eq("id", userId)
    .eq("role", "reader")
    .select(house ? "id, role, account_kind" : "id, role");
  const row = (Array.isArray(rows) ? rows[0] : undefined) as
    | { id?: unknown; role?: unknown; account_kind?: unknown }
    | undefined;
  if (
    error ||
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    row?.id !== userId ||
    row?.role !== "author" ||
    (house && row?.account_kind !== "publishing_house")
  ) {
    console.error("signup: the switch to author failed", {
      code: error?.code ?? null,
      rowCount: Array.isArray(rows) ? rows.length : null,
    });
    return false;
  }
  return true;
}
