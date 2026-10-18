import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isSchemaFeatureOffError, logSchemaFeatureOffOnce } from "@/lib/schema-feature-off";
import type { Book } from "@/lib/types";

// BOOK-PEN-NAME-RIGHTS-CHOICE-1: the book staff picked as "Librum's
// choice" (books.librum_choice_at, migration 20261018091237), only while
// it is still published; null when nothing is picked, before the
// migration, or on any error. Not called by any page in F3: F5 wires it
// into the Bookstore, where an empty pick keeps the "New on Librum"
// label (newest book) and never says "Librum's choice".
export async function getLibrumChoiceBook(): Promise<Book | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("books")
    .select("*")
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
  return (data as Book | null) ?? null;
}
