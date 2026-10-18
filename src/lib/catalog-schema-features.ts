import "server-only";
import { createClient } from "@/lib/supabase/server";
import { isSchemaFeatureOffError, logSchemaFeatureOffOnce } from "@/lib/schema-feature-off";

// F4 (D1): whether migration 20261018091237's pen name column and rights
// table exist yet, so Add a book and the Edit page render the Pen name
// field and the Rights choice only when they can be saved. RENDERING
// ONLY: no server write is ever skipped or chosen because of these
// answers (createBook/updateBook write a submitted pen name whenever the
// key is present, and the publish gate reads the declaration itself).
//
// Each probe is a normal GET with the SESSION client, `limit(0)`, never
// `head: true`: postgrest-js turns a 404 with an empty body into a 204
// with no error, so a HEAD on a missing table would read as present. For
// the same reason a probe counts as present only on an error-free 200
// with an array body; anything else (a feature-off code, another error,
// a thrown request, an odd status) is "off". anon holds no SELECT on
// book_rights_declarations, so a signed-out probe reads as off too --
// both callers are signed-in pages.
//
// A present answer is cached for the life of the server process (the
// migration is never undone); an off answer is never cached, so the
// first request after the migration lands sees the fields.

export type CatalogSchemaFeatures = { penName: boolean; rights: boolean };

type ProbeResponse = { data: unknown; error: { code?: string | null } | null; status: number };

let penNamePresent = false;
let rightsPresent = false;

async function probe(feature: string, run: () => PromiseLike<ProbeResponse>): Promise<boolean> {
  try {
    const { data, error, status } = await run();
    if (error === null && status === 200 && Array.isArray(data)) return true;
    if (error && isSchemaFeatureOffError(error)) {
      logSchemaFeatureOffOnce(feature, error);
    } else {
      console.error(`getCatalogSchemaFeatures: ${feature} probe did not confirm the feature`, {
        status,
        code: error?.code ?? null,
      });
    }
    return false;
  } catch (error) {
    console.error(`getCatalogSchemaFeatures: ${feature} probe failed`, error);
    return false;
  }
}

export async function getCatalogSchemaFeatures(): Promise<CatalogSchemaFeatures> {
  if (penNamePresent && rightsPresent) return { penName: true, rights: true };

  const supabase = await createClient();
  const [penName, rights] = await Promise.all([
    penNamePresent ||
      probe("book pen name", () => supabase.from("books").select("pen_name").limit(0)),
    rightsPresent ||
      probe("book rights declarations", () =>
        supabase.from("book_rights_declarations").select("id").limit(0),
      ),
  ]);
  if (penName) penNamePresent = true;
  if (rights) rightsPresent = true;
  return { penName, rights };
}

// Tests only: forget the cached answers.
export function resetCatalogSchemaFeaturesForTests(): void {
  penNamePresent = false;
  rightsPresent = false;
}
