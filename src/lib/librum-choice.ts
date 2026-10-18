import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isSchemaFeatureOffError, logSchemaFeatureOffOnce } from "@/lib/schema-feature-off";
import type { Book, Profile } from "@/lib/types";

// BOOK-PEN-NAME-RIGHTS-CHOICE-1: the book staff picked as "Librum's
// choice" (books.librum_choice_at, migration 20261018091237), only while
// it is still published; null when nothing is picked, before the
// migration, or on any error. Not called by any page in F3: F5 wires it
// into the Bookstore, where an empty pick keeps the "New on Librum"
// label (newest book) and never says "Librum's choice".
//
// F5 (C2/C3): the row carries its author's public name through the
// public author view (aliased to `profiles`, as the Bookstore's own
// rows), so the Bookstore block and the homepage spine show the same
// byline as for any other book. `*` already carries pen_name.
export type LibrumChoiceBook = Book & {
  profiles: Pick<Profile, "public_author_name"> | null;
};

export async function getLibrumChoiceBook(): Promise<LibrumChoiceBook | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select("*, profiles:public_author_profiles(public_author_name)")
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
