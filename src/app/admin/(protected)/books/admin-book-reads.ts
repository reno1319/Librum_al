import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

// ADMIN-2-TAKEDOWN (M2, R2): staff pages must show drafts and taken-down
// books. A staff session sees every book only once PEN-NAMES-2's contract
// step has added "Staff with reports.resolve can view every book" (13a);
// before that, only PUBLISHED books -- a report on a draft would read
// "Book unavailable". So the admin pages read book titles and takedown
// state with the service-role client, and ONLY after their own
// requireStaff(...) check has passed. Never import this from a page or
// action that has not checked staff first (the PEN-NAMES-2 static guard
// lists its callers).

export type StaffBookTitles = { ok: true; titleById: Map<string, string> } | { ok: false };

export async function readBookTitlesForStaff(bookIds: readonly string[]): Promise<StaffBookTitles> {
  const ids = Array.from(new Set(bookIds.filter(Boolean)));
  const titleById = new Map<string, string>();
  if (ids.length === 0) return { ok: true, titleById };
  const { data, error } = await createAdminClient()
    .from("books")
    .select("id, title")
    .in("id", ids)
    .returns<{ id: string; title: string }[]>();
  if (error) {
    console.error("readBookTitlesForStaff: read failed", { error });
    return { ok: false };
  }
  for (const book of data ?? []) titleById.set(book.id, book.title);
  return { ok: true, titleById };
}

/** The ids of every book with an ACTIVE takedown (a small set), or null on a read error. */
export async function readActiveTakedownBookIds(): Promise<Set<string> | null> {
  const { data, error } = await createAdminClient()
    .from("book_takedowns")
    .select("book_id")
    .is("lifted_at", null)
    .returns<{ book_id: string | null }[]>();
  if (error) {
    console.error("readActiveTakedownBookIds: read failed", { error });
    return null;
  }
  return new Set((data ?? []).map((row) => row.book_id).filter((id): id is string => id !== null));
}
