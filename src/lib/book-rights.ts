import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePublicAuthorName } from "@/lib/author-name";
import { RIGHTS_STATEMENT_VERSION, RIGHTS_STATEMENTS, isRightsBasis } from "@/lib/rights-statements";
import { isSchemaFeatureOffError, logSchemaFeatureOffOnce } from "@/lib/schema-feature-off";
import type { BookRightsDeclaration } from "@/lib/types";

// BOOK-PEN-NAME-RIGHTS-CHOICE-1: recording and reading an author's rights
// declaration for a book (public.book_rights_declarations, migration
// 20261018091237). Server-only helpers, not Server Actions: F4 calls them
// from its own actions (Add a book, Edit, the publish gate), which run the
// maintenance and recovery gates first.
//
// The table is append-only and anon/authenticated hold no write on it, so
// the one insert goes through the service role, and only after the
// session client has proved the caller is signed in and owns the book.
// Every value in the row comes from the server: the book id and title
// from the owned row, the author id from auth.getUser(), the public name
// from the caller's own profile, and the sentence and its version from
// RIGHTS_STATEMENTS. The client supplies only the book id to look up and
// which of the two bases it chose.

const FEATURE = "book rights declarations";

export type RecordRightsDeclarationRefusal =
  | "invalid_basis"
  | "unauthenticated"
  | "not_owner"
  | "no_author_name"
  | "feature_off"
  | "error";

export type RecordRightsDeclarationResult =
  | { ok: true; declaration: BookRightsDeclaration }
  | { ok: false; reason: RecordRightsDeclarationRefusal };

export async function recordRightsDeclaration(
  bookId: string,
  basis: unknown,
): Promise<RecordRightsDeclarationResult> {
  if (!isRightsBasis(basis)) return { ok: false, reason: "invalid_basis" };

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, reason: "unauthenticated" };

  const { data: book, error: bookError } = await supabase
    .from("books")
    .select("id, title")
    .eq("id", bookId)
    .eq("author_id", user.id)
    .maybeSingle();
  if (bookError) {
    console.error("recordRightsDeclaration: book lookup failed:", bookError);
    return { ok: false, reason: "error" };
  }
  if (!book) return { ok: false, reason: "not_owner" };

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("display_name, public_author_name")
    .eq("id", user.id)
    .maybeSingle();
  if (profileError) {
    console.error("recordRightsDeclaration: profile lookup failed:", profileError);
    return { ok: false, reason: "error" };
  }
  // author_public_name is NOT NULL: refuse here instead of letting the
  // insert fail with 23502 when no profile row was loaded.
  const authorPublicName = resolvePublicAuthorName(profile);
  if (!authorPublicName || !authorPublicName.trim()) return { ok: false, reason: "no_author_name" };

  const { data: declaration, error: insertError } = await createAdminClient()
    .from("book_rights_declarations")
    .insert({
      book_id: book.id,
      book_title: book.title,
      author_id: user.id,
      author_public_name: authorPublicName,
      basis,
      statement_version: RIGHTS_STATEMENT_VERSION,
      statement_text: RIGHTS_STATEMENTS[basis].text,
    })
    .select("*")
    .single();
  if (insertError) {
    if (isSchemaFeatureOffError(insertError)) {
      logSchemaFeatureOffOnce(FEATURE, insertError);
      return { ok: false, reason: "feature_off" };
    }
    console.error("recordRightsDeclaration: insert failed:", insertError);
    return { ok: false, reason: "error" };
  }
  if (!declaration) return { ok: false, reason: "error" };

  return { ok: true, declaration: declaration as BookRightsDeclaration };
}

// F4: the publish gate's three-way read of a book's current declaration
// (its newest row), with the caller's own session: RLS shows an author
// only their own declarations. `none` means the read worked and found
// nothing; `unavailable` means it could not be answered -- signed out,
// before the migration (feature off), or any read error. performPublish
// refuses on both, with different messages (missing_rights /
// rights_unavailable), so the gate fails closed and never mistakes "we
// couldn't tell" for "no choice yet".
export type RightsDeclarationState =
  | { kind: "present"; declaration: BookRightsDeclaration }
  | { kind: "none" }
  | { kind: "unavailable" };

export async function getRightsDeclarationState(bookId: string): Promise<RightsDeclarationState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: "unavailable" };

  const { data, error } = await supabase
    .from("book_rights_declarations")
    .select("*")
    .eq("book_id", bookId)
    .order("declared_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    if (isSchemaFeatureOffError(error)) {
      logSchemaFeatureOffOnce(FEATURE, error);
    } else {
      console.error("getRightsDeclarationState: read failed:", error);
    }
    return { kind: "unavailable" };
  }
  if (!data) return { kind: "none" };
  return { kind: "present", declaration: data as BookRightsDeclaration };
}

// The book's current declaration (its newest row), or null when there is
// none, when the caller is signed out, before the migration, or on any
// error -- a caller gating on it therefore fails closed. The publish gate
// uses getRightsDeclarationState above, which tells those cases apart.
export async function getCurrentRightsDeclaration(bookId: string): Promise<BookRightsDeclaration | null> {
  const state = await getRightsDeclarationState(bookId);
  return state.kind === "present" ? state.declaration : null;
}
