import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isSchemaFeatureOffError, logSchemaFeatureOffOnce } from "@/lib/schema-feature-off";
import type { PublicBook } from "@/lib/types";
import type { PenNameRef } from "@/lib/pen-names";

// BOOK-PEN-NAME-RIGHTS-CHOICE-1: the book staff picked as "Librum's
// choice" (books.librum_choice_at, migration 20261018091237), only while
// it is still published; null when nothing is picked, before the
// migration, or on any error. Not called by any page in F3: F5 wires it
// into the Bookstore, where an empty pick keeps the "New on Librum"
// label (newest book) and never says "Librum's choice".
//
// F5 (C2/C3) / PEN-NAMES-1: the row carries its pen name through the
// public_pen_names view (embedded as `pen`, as the Bookstore's own
// rows), so the Bookstore block and the homepage spine show the same
// byline, linking to the same pen name page, as for any other book.
// PEN-NAMES-2: read from public_books (no account columns).
export type LibrumChoiceBook = PublicBook & {
  pen: PenNameRef | null;
};

export async function getLibrumChoiceBook(): Promise<LibrumChoiceBook | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("public_books")
    .select("*, pen:public_pen_names(id, name)")
    .not("librum_choice_at", "is", null)
    .eq("status", "published")
    .maybeSingle();
  if (error) {
    if (isSchemaFeatureOffError(error)) {
      logSchemaFeatureOffOnce("Librum's choice", error);
    } else {
      console.error("getLibrumChoiceBook: read failed:", error);
    }
    return null;
  }
  return (data as LibrumChoiceBook | null) ?? null;
}
