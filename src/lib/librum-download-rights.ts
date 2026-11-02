import type { SupabaseClient } from "@supabase/supabase-js";
import { isRightsBasis } from "@/lib/rights-statements";
import type { RightsBasis } from "@/lib/types";

// BD3 patch 3 (Renato 1 Nov, 1a 2a): which rights basis the author
// declared last for this book, for the Librum copyright page.
//
// Read with the SERVICE ROLE, by the download route only, after it has
// decided the caller may download this book: book_rights_declarations
// is readable only by the book's author (RLS "Authors can read their
// own rights declarations"), so a buyer's session cannot see it. The
// read is narrowed to this one book id and the one column `basis`; the
// rest of the row (the author's name, the sentence) never leaves the
// database. Patch 1's page details stay on the caller's session.
//
// Never throws and never logs (the route logs its fallback once).
//   { ok: true, basis }      the newest declaration's basis
//   { ok: true, basis: null } no declaration (or an unknown value): the
//                            ordinary © page, as before this patch
//   { ok: false }            the read failed. The route then serves the
//                            book WITHOUT the Librum pages, so a public-
//                            domain book never gets a false © line
//                            (audit r1, N3).
export type RightsBasisRead = { ok: true; basis: RightsBasis | null } | { ok: false };

export async function readRightsBasisForPages(admin: SupabaseClient, bookId: string): Promise<RightsBasisRead> {
  try {
    const { data, error } = await admin
      .from("book_rights_declarations")
      .select("basis")
      .eq("book_id", bookId)
      .order("declared_at", { ascending: false })
      // BD3 patch 4 (coordinator): two declarations with the same
      // declared_at always resolve the same way.
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) return { ok: false };
    const basis = (data as { basis?: unknown } | null)?.basis;
    return { ok: true, basis: isRightsBasis(basis) ? basis : null };
  } catch {
    return { ok: false };
  }
}
